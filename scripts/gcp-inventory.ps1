[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')][string]$ProjectId,
    [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$')][string]$DeployServiceAccount,
    [Parameter(Mandatory)][string]$GcloudPath,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [ValidatePattern('^[a-z]+-[a-z]+[0-9]+$')][string]$Region
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (($DeployServiceAccount -split '@')[1] -ne "$ProjectId.iam.gserviceaccount.com") { throw 'DeployServiceAccount must belong to the explicit project.' }
$utf8 = [Text.UTF8Encoding]::new($false)
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\', '/')
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'OutputDirectory must be absolute.' }
$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\', '/')
if ($output.Equals($repo, [StringComparison]::OrdinalIgnoreCase) -or $output.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence must be outside the repository.' }
if (Test-Path -LiteralPath $output) { throw 'Use a new protected evidence directory.' }
$ancestor = [IO.DirectoryInfo]::new($output).Parent
while ($null -ne $ancestor) {
    if ($ancestor.Exists -and ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Evidence path cannot contain reparse points.' }
    $ancestor = $ancestor.Parent
}
if (-not [IO.Path]::IsPathRooted($GcloudPath) -or -not (Test-Path -LiteralPath $GcloudPath -PathType Leaf)) { throw 'GcloudPath must identify an existing absolute executable path.' }
$gcloud = (Get-Item -LiteralPath $GcloudPath)
if ($gcloud.Name -notin @('gcloud.cmd', 'gcloud.exe', 'gcloud')) { throw 'Select the reviewed gcloud executable.' }
[IO.Directory]::CreateDirectory($output) | Out-Null
$entries = [Collections.Generic.List[object]]::new()
function Save-Json([string]$Name, $Value) {
    [IO.File]::WriteAllText((Join-Path $output ($Name + '.json')), (($Value | ConvertTo-Json -Depth 50) + "`n"), $utf8)
}
function Read-Metadata([string]$Name, [string[]]$Arguments, [string]$Projection = 'json') {
    $started = [DateTime]::UtcNow.ToString('o')
    $stderr = Join-Path $output 'discarded-stderr.tmp'
    $previousPromptSetting = [Environment]::GetEnvironmentVariable('CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API', 'Process')
    try {
        # SDK 586 core API error handler checks this property before API enablement.
        [Environment]::SetEnvironmentVariable('CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API', 'false', 'Process')
        $raw = & $gcloud.FullName @Arguments "--project=$ProjectId" '--quiet' '--no-log-http' '--verbosity=none' "--format=$Projection" 2>$stderr
        $code = $LASTEXITCODE
        if ($code -ne 0) { throw 'Read command failed.' }
        $json = ($raw -join "`n").Replace("`r`n", "`n").Replace("`r", "`n")
        $value = $json | ConvertFrom-Json
        [IO.File]::WriteAllText((Join-Path $output ($Name + '.json')), ($json + "`n"), $utf8)
        $entries.Add([ordered]@{ name=$Name; status='read'; startedUtc=$started; finishedUtc=[DateTime]::UtcNow.ToString('o'); arguments=$Arguments; projection=$Projection })
        return $value
    } catch {
        $entries.Add([ordered]@{ name=$Name; status='incomplete'; startedUtc=$started; finishedUtc=[DateTime]::UtcNow.ToString('o'); arguments=$Arguments; projection=$Projection; reason='Command failed or returned invalid JSON; do not infer absence.' })
        return $null
    } finally {
        [Environment]::SetEnvironmentVariable('CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API', $previousPromptSetting, 'Process')
        if (Test-Path -LiteralPath $stderr) { Remove-Item -LiteralPath $stderr -Force }
    }
}
$null = Read-Metadata 'project' @('projects','describe',$ProjectId) 'json(projectId,projectNumber,lifecycleState,parent,labels)'
$null = Read-Metadata 'billing' @('billing','projects','describe',$ProjectId) 'json(projectId,billingAccountName,billingEnabled)'
$null = Read-Metadata 'enabled-apis' @('services','list','--enabled') 'json(config.name,state)'
$null = Read-Metadata 'databases' @('firestore','databases','list') 'json(name,locationId,type,databaseEdition,deleteProtectionState)'
$db = Read-Metadata 'default-database' @('firestore','databases','describe','--database=(default)') 'json(name,locationId,type,databaseEdition,deleteProtectionState)'
$null = Read-Metadata 'composite-indexes' @('firestore','indexes','composite','list','--database=(default)')
$null = Read-Metadata 'field-exemptions' @('firestore','indexes','fields','list','--database=(default)')
$null = Read-Metadata 'buckets' @('storage','buckets','list') 'json(name,location,location_type,storage_class,public_access_prevention,uniform_bucket_level_access)'
$null = Read-Metadata 'artifact-repositories' @('artifacts','repositories','list','--location=all') 'json(name,format,mode,createTime,labels)'
$null = Read-Metadata 'secrets-metadata' @('secrets','list') 'json(name,createTime,replication,labels)'
$null = Read-Metadata 'service-accounts' @('iam','service-accounts','list') 'json(name,email,disabled,displayName)'
$null = Read-Metadata 'project-iam' @('projects','get-iam-policy',$ProjectId) 'json(version,bindings,etag)'
$null = Read-Metadata 'deploy-account' @('iam','service-accounts','describe',$DeployServiceAccount) 'json(name,email,disabled,displayName)'
$null = Read-Metadata 'deploy-account-iam' @('iam','service-accounts','get-iam-policy',$DeployServiceAccount) 'json(version,bindings,etag)'
$pools = Read-Metadata 'wif-pools' @('iam','workload-identity-pools','list','--location=global','--show-deleted') 'json(name,state,disabled,displayName)'
foreach ($pool in @($pools)) {
    if ($null -eq $pool) { continue }
    if (-not $pool.PSObject.Properties['name']) { continue }
    $id = ($pool.name -split '/')[-1]
    if ($id -notmatch '^[a-z0-9-]{4,32}$') { continue }
    $null = Read-Metadata ('wif-providers-' + $id) @('iam','workload-identity-pools','providers','list','--location=global',"--workload-identity-pool=$id",'--show-deleted') 'json(name,state,disabled,oidc,attributeMapping,attributeCondition)'
}
# Cross-region discovery excludes service definitions, env values, job payloads and secret contents.
# Cloud Scheduler is not a supported CAI asset type; retain the regional metadata list below.
$null = Read-Metadata 'cross-region-resource-metadata' @('asset','search-all-resources',"--scope=projects/$ProjectId",'--asset-types=run.googleapis.com/Service,cloudtasks.googleapis.com/Queue,artifactregistry.googleapis.com/Repository,storage.googleapis.com/Bucket,secretmanager.googleapis.com/Secret','--read-mask=name,assetType,location,state') 'json(name,assetType,location,state)'
if (-not $Region -and $null -ne $db -and $db.PSObject.Properties['locationId'] -and $db.locationId -match '^[a-z]+-[a-z]+[0-9]+$') { $Region = $db.locationId }
if ($Region) {
    $null = Read-Metadata 'regional-run-services' @('run','services','list',"--region=$Region",'--platform=managed') 'json(metadata.name,metadata.labels,status.url,status.conditions)'
    $null = Read-Metadata 'regional-task-queues' @('tasks','queues','list',"--location=$Region") 'json(name,state,rateLimits,retryConfig)'
    $null = Read-Metadata 'regional-scheduler-jobs' @('scheduler','jobs','list',"--location=$Region") 'json(name,state,schedule,timeZone)'
} else {
    $entries.Add([ordered]@{name='regional-service-inventory'; status='incomplete'; reason='No explicit region or verified regional default database location; multi-region is not a deploy region.'})
}
$summary = [ordered]@{
    capturedUtc=[DateTime]::UtcNow.ToString('o'); projectId=$ProjectId; deployServiceAccount=$DeployServiceAccount; selectedRegion=$Region
    mode='read-only metadata; no deployment'; entries=$entries.ToArray()
    manualPending=@('Ownership and naming review; no empty result proves a name is free', 'Inherited/conditional effective deploy IAM and service account owner review', 'Live Firestore Security Rules reading and client-path denial tests', 'Actual runtime identity IAM and out-of-scope database denial tests', 'Billing budget ownership and cost review', 'Asset Inventory supported-type coverage, freshness and cross-region completeness review', 'Cloud Scheduler jobs outside the selected region require separate metadata lists; CAI does not cover Scheduler')
}
Save-Json 'summary' $summary
$failed = @($entries | Where-Object { $_.status -eq 'incomplete' }).Count
Write-Output ("Metadata checks: {0} read, {1} incomplete. Manual gates pending; no deployment performed." -f ($entries.Count - $failed), $failed)
if ($failed -gt 0) { exit 2 }

# LeaseRegistryのローカルartifactと手動登録

T-07のcontract準備と手動登録手順。Ethereum Sepoliaへ人間承認のwallet署名でdeployし、独立した公開RPC検査でreceipt、runtime code、初期rolesを照合した。MultiBaasでもalias作成・contract linkと設定read-backを確認した。MultiBaasのindexed events、LeaseRegistryのrecord/revoke write、chain worker接続は未完了で、T-07は未完了。

## Buildとexport

Foundry 1.7.1、Solidity 0.8.30、OpenZeppelin Contracts 5.4.0を使用する。optimizerは200 runs、EVMはCancun。workspaceの依存をlockfileから導入した後、repository rootから実行する。

```powershell
Push-Location contracts
forge build
forge test
Pop-Location
node scripts/export-lease-registry.mjs
```

exportは`contracts/out/LeaseRegistry.sol/LeaseRegistry.json`を検査し、未追跡の`contracts/dist/`へ次を出力する。外部API呼出やdeployは行わない。

| ファイル | 用途 |
| --- | --- |
| `LeaseRegistry.json` | Forge互換のABI、creation bytecode、runtime bytecode。MultiBaas Libraryへの投入候補 |
| `LeaseRegistry.abi.json` | ABI単体。deploy済みaddressをlinkする場合のinterface |
| `deployment-manifest.json` | chain ID 11155111、compiler/settings、constructor型、bytecode/ABI/sourceのSHA-256 |

compiler/settings/contract/constructor不一致、空bytecode、未解決library link、想定外または絶対source pathはexportを拒否する。manifestのhashはローカルartifactの照合用であり、on-chain deployの証明ではない。runtimeにはconstructorによる変更がない現在のcontractを前提とし、deploy後のcodeを照合する。

各sourceのKeccak-256をcompiler metadataと照合し、build後の変更があれば再buildを要求する。Forgeの`rawMetadata`があればcompiler元データとして優先し、なければ`metadata`を使う。metadataのABIは必須とし、artifact ABIとの一致も検査する。object keyとトップレベルentryの並び順だけを同等と扱い、引数・戻り値・tupleの順序と型は維持する。

## MultiBaas UIによる手動deploy

### walletが未準備の場合

1. 本人が公式walletを作成し、復旧情報は本人だけで保持する。候補例は[MetaMask公式download](https://metamask.io/download/)。秘密鍵・seed phraseをこの手順やassistantへ入力しない。
2. [公式testnet表示手順](https://support.metamask.io/configure/networks/how-to-view-testnets-in-metamask/)に従い、Ethereum Sepoliaを選ぶ。
3. [公式testnet案内](https://support.metamask.io/develop/blockchain-networks/testnets/)のfaucetからtest ETHを取得し、MultiBaasへ接続する。mainnet資金や暗号資産の購入は不要。

### artifact投入と照合

[公式Library手順](https://docs.curvegrid.com/multibaas/manage-contracts)はForge compilation artifactまたはABIのJSON uploadを支持する。ABI単体にはdeploy用bytecodeがないため、今回は`LeaseRegistry.json`を優先する。flattened Solidityやstandard JSON compiler inputの投入は前提にしない。今回は検証済みartifactのABIとcreation bytecodeを公式APIのlibrary definitionとして登録し、versionのread-backと内容一致を確認済み。UI経由のartifact uploadとUIでのdeployは未検証。実deploymentは後述のlocal helperで完了し、独立RPCで照合した。

1. 人間がwalletを準備し、Ethereum Sepoliaとgas残高を確認する。秘密鍵・seed phraseをassistant、prompt、repository、ログへ渡さない。手動testではconstructorの`admin`と`writer`に接続walletを指定する。
2. MultiBaasのContracts → LibraryでForge artifactをuploadする。`LeaseRegistry`のconstructorが`admin: address`、`writer: address`で、期待するABIとbytecodeであることを確認し、label/versionを固定する。
3. [Signer Selector](https://docs.curvegrid.com/multibaas/signer-selector/)で人間の接続walletを選ぶ。deploymentとwalletのnetworkがEthereum Sepoliaで一致することを確認する。
4. Contracts → On-chain → Deploy Contractを開き、Contract from Libraryから登録済み`LeaseRegistry`を選ぶ。人間がconstructorの`admin`・`writer`を指定し、両方ともzero addressでないことを確認してwalletで署名する。`admin`には`DEFAULT_ADMIN_ROLE`、`writer`には`WRITER_ROLE`が付く。
5. receiptの成功、chain ID、contract address、runtime code、初期rolesを照合する。sync eventsを有効にし、starting blockをdeploy receiptのblockに合わせる。既にdeployしたcontractを使う場合はLibraryのABIをOn-chain → Link Contractでそのaddressへlinkする。
6. 確認した`REGISTRY_ADDRESS`、`REGISTRY_CHAIN_ID=11155111`、`REGISTRY_CONTRACT_LABEL`、`MULTIBAAS_CHAIN_LABEL`、固定version・ABI hash等を保護された設定へ保存する。実値やwallet識別子はrepositoryへ記録しない。

### UI deployでtransactionが得られない場合

MultiBaas UIで正しいconstructor値を指定しても「Missing the transaction to continue」となり、wallet署名画面が開かない事象が確認されている。これはUI側の原因が確定したことを意味しない。登録済みdefinitionのABI・bytecode一致だけではdeploy成功とみなさない。

ローカル補助画面を用意した。`REGISTRY_DEPLOY_WALLET`には手動testで`admin`・`writer`に使うwallet addressをローカル環境変数として設定し、`node scripts/serve-registry-deploy.mjs --wallet "$env:REGISTRY_DEPLOY_WALLET" --port <port>`を起動する。helperはreview済みartifactのみを使い、`127.0.0.1`だけにbindし、chain ID 11155111以外では動作しない。serverが表示するloopback URLを、MetaMaskが有効な同じbrowserで開き、connect後にestimate結果とtransaction内容を確認して、人間がwallet上で承認する。serverやrepositoryへ鍵・seed phrase・MultiBaas API secretを設定しない。

送信結果が不明なら再試行せず、先にchain上で結果を照合する。確定したtransactionのreceipt、runtime code、rolesをon-chainで確認してからMultiBaasでcontractをlinkする。helper/browserからのreceipt・code報告だけではdeploy成功の証拠とせず、毎回独立したRPCでreceipt、runtime code、rolesを検証する。今回のdeployではその独立確認を完了した。同一artifactとwalletについて同時起動を拒否する。異常終了で起動用lockが残った場合は、記録されたprocessが停止済みかを確認してから起動用lockだけを整理し、送信試行の状態は保持する。

その後、固定ABIの`getLease`、許可writerのwrite/read一致、無権限write拒否、eventsのblock hash/log indexを実確認する。未確認の応答やSDK methodで成功を代用しない。[公式API](https://docs.curvegrid.com/multibaas/api/multibaas-api/)と[deploy API説明](https://docs.curvegrid.com/multibaas/api/deploy-contract/)を参照する。購入・決済を有効化する手順ではない。

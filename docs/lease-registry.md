# LeaseRegistryのローカルartifactと手動登録

T-07のcontract準備と手動登録手順。本人が準備したwalletはEthereum Sepolia上で公開read-only確認済み（checksum形式、残高あり、codeなし）で、MultiBaasへのwallet接続は本人から完了の報告を受けた。registry library definitionを登録し、versionのread-backとABI・creation bytecodeのartifact一致を確認した。これはlibrary登録のみで、実deploy/transaction、roles設定、contract read/write/eventsは未実施。chain操作workerは未接続で、T-07は未完了。

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

[公式Library手順](https://docs.curvegrid.com/multibaas/manage-contracts)はForge compilation artifactまたはABIのJSON uploadを支持する。ABI単体にはdeploy用bytecodeがないため、今回は`LeaseRegistry.json`を優先する。flattened Solidityやstandard JSON compiler inputの投入は前提にしない。今回は検証済みartifactのABIとcreation bytecodeを公式APIのlibrary definitionとして登録し、versionのread-backと内容一致を確認済み。UI経由のartifact uploadと実deploymentは未検証。

1. 人間がwalletを準備し、Ethereum Sepoliaとgas残高を確認する。秘密鍵・seed phraseをassistant、prompt、repository、ログへ渡さない。初期`admin`と`writer`は別主体を推奨する。
2. MultiBaasのContracts → LibraryでForge artifactをuploadする。`LeaseRegistry`のconstructorが`admin: address`、`writer: address`で、期待するABIとbytecodeであることを確認し、label/versionを固定する。
3. [Signer Selector](https://docs.curvegrid.com/multibaas/signer-selector/)で人間の接続walletを選ぶ。deploymentとwalletのnetworkがEthereum Sepoliaで一致することを確認する。
4. Contracts → On-chain → Deploy Contractを選び、人間がconstructorの`admin`・`writer`を指定してwalletで署名する。両方ともzero addressは禁止。`admin`には`DEFAULT_ADMIN_ROLE`、`writer`には`WRITER_ROLE`が付く。
5. receiptの成功、chain ID、contract address、runtime code、初期rolesを照合する。sync eventsを有効にし、starting blockをdeploy receiptのblockに合わせる。既にdeployしたcontractを使う場合はLibraryのABIをOn-chain → Link Contractでそのaddressへlinkする。
6. 確認した`REGISTRY_ADDRESS`、`REGISTRY_CHAIN_ID=11155111`、`REGISTRY_CONTRACT_LABEL`、`MULTIBAAS_CHAIN_LABEL`、固定version・ABI hash等を保護された設定へ保存する。実値やwallet識別子はrepositoryへ記録しない。

その後、固定ABIの`getLease`、許可writerのwrite/read一致、無権限write拒否、eventsのblock hash/log indexを実確認する。未確認の応答やSDK methodで成功を代用しない。[公式API](https://docs.curvegrid.com/multibaas/api/multibaas-api/)と[deploy API説明](https://docs.curvegrid.com/multibaas/api/deploy-contract/)を参照する。購入・決済を有効化する手順ではない。

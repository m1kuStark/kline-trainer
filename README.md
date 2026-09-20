# A股K线训练器（kline-trainer）

离线的A股K线逐日训练工具：读取你电脑里已有的通达信日线数据，逐日推进行情，练习判断、下单和画线，结束后查看这笔训练的结果。界面为中文，K线红涨绿跌。

它能做什么（以当前版本实际能力为准）：

- **逐日训练**：自选股票与区间（1M/3M/6M/1Y/2Y）和初始资金，按空格逐日推进，按当日收盘价成交，T+1、整手100股，可提前结算或到期结算。
- **图表**：日/周/月周期，MA、VOL、MACD，23种画线工具并随训练保存；默认前复权显示。
- **录制与回放**：训练操作默认录制、可暂停；导出压缩文件分享，对方用本工具导入即可逐步回放，不依赖你本机的数据路径。
- **数据本地化**：只读取你本机通达信目录里的日线和权息文件，不联网下载行情，安装包也不含任何市场数据。

它不是什么：这是个人训练工具，不是券商交易软件，没有自动交易，也不提供投资建议。完整排行与成绩单、复盘分析、设置页等属于后续版本，当前入口为禁用状态。

## 快速开始（Windows）

1. 到 [Releases](https://github.com/m1kuStark/kline-trainer/releases) 下载 `kline-trainer-v0.3.1-windows-x64.zip`（该文件由维护者随 v0.3.1 发布，页面暂未出现时请稍候）。安装包自带运行环境，**无需安装 Node、npm 或 Python，无需订阅、模型或账号**。
2. 右键完整解压到一个固定文件夹（之后不要移动它）。
3. 在解压目录里参照 `trainer.config.example.json` 新建 `trainer.config.json`，把 `tdxRoot` 指向你的通达信目录（JSON 里反斜杠写成 `\\`），并确认通达信已下载日线数据。
4. 双击 `Start.cmd`，浏览器自动打开 `http://127.0.0.1:8787`。
5. 双击 `Create Shortcut.cmd` 创建桌面图标，以后从图标启动。

程序只监听本机 `127.0.0.1`，不对外网开放。详细步骤与配置字段见[安装与配置](docs/user/install.md)。

## 文档

| 想了解 | 入口 |
|---|---|
| 日常使用、快捷键、数据备份与升级 | [用户指南](docs/user/README.md) |
| 下载安装、通达信目录配置、源码运行 | [安装与配置](docs/user/install.md) |
| 录制、回放与分享 | [录制说明](docs/user/recording.md) |
| 启动失败、找不到数据、端口占用等 | [常见问题](docs/user/troubleshooting.md) |

## 从源码运行

需要 Node 24 与 npm 10+：

```powershell
npm ci
npm run build
npm start
```

环境变量示例（PowerShell）：`$env:TDX_ROOT='D:\new_tdx'`、`$env:PORT='8787'`、`$env:TRAINER_DB='D:\data\trainer.sqlite'`。开发与测试说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 参与与反馈

- 贡献代码或文档：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全问题请勿在公开 Issue 中描述，走 [SECURITY.md](SECURITY.md) 的渠道
- 使用问题先查[常见问题](docs/user/troubleshooting.md)；反馈时不要附个人交易数据

## 许可证

项目原创代码以 [MIT](LICENSE) 发布，第三方组件及权息解码表的来源、授权现状见[第三方声明](THIRD-PARTY-NOTICES.md)。通达信软件及其数据文件由使用者自行提供、只读使用。

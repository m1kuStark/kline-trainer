# 安装与配置

两种使用方式：**Windows一键版**（推荐，解压即用）和**源码运行**（适合想自己构建的开发者）。两种方式都需要你本机已有通达信目录并提供日线数据；训练器不联网下载行情。

## 方式一：Windows 一键版

### 1. 下载

到 [Releases 页面](https://github.com/m1kuStark/kline-trainer/releases) 下载 `kline-trainer-v0.3.2-windows-x64.zip`。发布包内已自带 Node 运行时，**无需安装 Node、npm 或 Python，无需订阅、账号或管理员权限**。

### 2. 解压

右键压缩包选择"全部解压缩"，解压到一个**固定的普通文件夹**，例如 `D:\kline-trainer`。注意：

- 不要在压缩软件窗口里直接双击运行，必须先完整解压。
- 之后的升级、快捷方式都依赖这个目录的位置，装好后不要随意移动或重命名。
- 不需要放在 `C:\Program Files` 等需要管理员权限的位置。

### 3. 配置通达信目录

先双击 `Start.cmd` 尝试启动，可以不建配置文件。v0.3.2 只检查 `D:\MySoftWares\TDX`、`C:\new_tdx`、`C:\通达信` 三个位置，并不搜索整个电脑。能搜索股票、正常加载行情时可跳过手动配置；找到目录仍可能缺少日线或权息数据。

若显示“TDX 未连接”，在解压目录中复制 `trainer.config.example.json`，将副本准确命名为 `trainer.config.json`，把 `tdxRoot` 改为通达信安装目录。资源管理器中先打开“显示 → 文件扩展名”，确认没有变成 `.json.txt` 或 `.jison`；配置向导尚未实现。**JSON 中 Windows 路径的反斜杠要写成两个**：

```json
{
  "tdxRoot": "D:\\new_tdx"
}
```

全部配置字段：

| 字段 | 说明 | 默认值 |
|---|---|---|
| `tdxRoot` | 通达信安装目录（建议写绝对路径）。留空字符串时程序会尝试探测常见的通达信位置，探测失败就必须手动填写。 | `""`（自动探测） |
| `port` | 本机服务端口 | `8787` |
| `dataDir` | 数据目录，存放数据库、日志和运行状态 | `%USERPROFILE%\.a-share-kline-trainer` |
| `databasePath` | 训练数据库文件路径（可选，写绝对路径） | 数据目录下的 `trainer.sqlite` |

### 4. 确认通达信文件齐全

训练器只读取以下文件（只读，不修改）：

- `vipdoc\sh\lday\` 和 `vipdoc\sz\lday\` 下的日线文件（`*.day`，沪市和深市）
- `T0002\hq_cache\gbbq`（分红送转等权息数据）
- `T0002\hq_cache\` 下的证券名称文件（`shs.tnf`、`szs.tnf` 或 `base.dbf`）

如果目录里缺少日线，请先打开你自己的通达信客户端下载盘后日线数据，再回到训练器。训练器本身**不会联网下载任何行情数据**。

### 5. 启动

双击 `Start.cmd`：程序在本机启动服务并自动打开浏览器访问 `http://127.0.0.1:8787`。服务只监听本机回环地址，不对外网开放。

- 浏览器没有自动打开时，手动访问 `http://127.0.0.1:8787` 即可。建议使用较新的 Microsoft Edge 或 Chrome。
- 重复双击 `Start.cmd` 会复用同一数据目录记录、身份匹配且健康的服务。版本、数据库、端口或行情目录有变化时，请先运行 `Stop.cmd` 再启动。
- 如果端口被其他程序占用，程序会明确报错退出，**不会自动换端口，也不会替你结束占用端口的进程**。先弄清占用者是什么再决定怎么处理，见[常见问题](troubleshooting.md)的端口一节。
- 启动失败时，先到数据目录（默认 `%USERPROFILE%\.a-share-kline-trainer`）里查看日志再排查。

### 6. 创建桌面图标

双击解压目录里的 `Create Shortcut.cmd`，会在桌面创建指向训练器的图标。之后每天双击图标即可启动。

### 升级版本

1. 先在旧版本目录双击 `Stop.cmd`，确认服务已停止。关闭浏览器页面不会停止服务。
2. 下载并解压新版本的 ZIP 到一个新文件夹。
3. 把旧目录中的 `trainer.config.json` 复制到新目录。
4. 用新目录重新创建桌面快捷方式（如目录名变了）。

默认数据目录保持不变，训练、成交和画线自动沿用。训练录像存在浏览器里，保持端口和浏览器不变即可继续使用；升级前如担心，可先导出重要录像。

日常需要退出后台服务时，同样双击 `Stop.cmd`。它只结束经过身份核对的本应用进程，保留训练数据和日志。停止前请等待训练页面的保存操作完成。

## 方式二：从源码运行

适合开发者。需要 Node.js 24 与 npm 10 以上版本。

```powershell
git clone https://github.com/m1kuStark/kline-trainer.git
cd kline-trainer
npm ci
npm run build
npm start
```

`npm start` 默认在 `127.0.0.1:8787` 同时托管页面和接口。可用环境变量调整（PowerShell 示例）：

```powershell
$env:TDX_ROOT = 'D:\new_tdx'            # 通达信目录
$env:PORT = '8787'                       # 端口
$env:HOST = '127.0.0.1'                  # 监听地址，保持本机
$env:TRAINER_DB = 'D:\data\trainer.sqlite'  # 训练数据库，不设则用默认数据目录
$env:OPEN_BROWSER = '0'                  # 不自动打开浏览器
npm start
```

不设 `TRAINER_DB` 时默认使用 `%USERPROFILE%\.a-share-kline-trainer\trainer.sqlite`，这是真实的训练库，请不要把它当测试库。开发调试用 `npm run dev`（页面5173、接口8787），启动前建议显式指定独立的开发数据库。贡献与测试说明见[CONTRIBUTING](../../CONTRIBUTING.md)。

## 下一步

- 日常使用：[用户指南](README.md)
- 录制、回放与分享：[录制说明](recording.md)
- 遇到问题：[常见问题](troubleshooting.md)

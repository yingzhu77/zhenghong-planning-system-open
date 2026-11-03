# 本地开发与交回审查

公开仓库提供应用源码、空库初始化、匿名演示和测试，不包含企业业务库、正式人员账号、附件、密钥或服务器配置。先读 [AGENTS.md](AGENTS.md)、[README.md](README.md) 及本指南，再按任务阅读 [文档索引](docs/README.md) 中的相关说明。

全新克隆没有私有的 `接续开发.md`，无需寻找或重建该文件。持有受控交接材料的维护者按其核对实例；普通贡献者以仓库文件、当前任务和 PR 为开发依据，不能将源码能力或本地演示写成线上已部署。

## 取得代码

安装 Git、Node.js 22.13 或更高的兼容版本，以及启用 Linux 容器的 Docker 和 Docker Compose。选择独立目录，避免覆盖已有工程。

有仓库写权限时：

```sh
git clone https://github.com/yingzhu77/zhenghong-planning-system-open.git
cd zhenghong-planning-system-open
git switch main
git pull --ff-only
git switch -c codex/your-task
npm ci --ignore-scripts
```

没有写权限时，先在 GitHub Fork 此仓库，再克隆自己的 Fork；将原仓库添加为 `upstream`，从最新 `upstream/main` 建立 `codex/your-task` 分支，最终向原仓库的 `main` 提交 PR。不要直接向 `main` 开发或强制推送他人的分支。

## 启动匿名预览

在新克隆的根目录执行：

```sh
node scripts/setup-env.mjs
```

它会生成随机本地密钥，不覆盖已有 `.env`。启动前检查该文件：使用本机预览来源、独立数据库和附件卷，不复用正式环境配置。同机已有其他实例时，先为 `COMPOSE_PROJECT_NAME`、`APP_IMAGE`、`APP_PORT` 和 `UPLOADS_VOLUME` 设置不同值（例如独立的 `APP_IMAGE=planning-my-task-api:local`），并将 `APP_ORIGIN` 改为匹配端口的 `http://localhost:端口`。默认端口为 8080，默认仅绑定本机。

```sh
docker compose config --quiet
docker compose up -d --build --wait
docker compose --profile tools run --rm admin npm run seed:demo
```

首次启动初始化空数据库；最后一条命令显式创建住宅、商业两个匿名演示项目，以及覆盖提报人、管理员、总裁、项目总的五个随机密码账号。浏览器打开 `http://localhost:8080`，用本机 `.local/demo-accounts.json` 中的对应账号登录；若改过端口，使用调整后的入口。该凭据文件只留在本机，不复制进聊天、截图、PR 或 Git。

演示初始化只执行一次。重复执行不会重置已有账号或覆盖已有数据；不要删除数据卷来处理“账号已存在”。健康或启动失败时，使用 `docker compose ps`、`docker compose logs --tail 100 db api` 定位失败服务；分享日志前去除凭据及私有内容。未配置 SMTP 时不以验证码邮件作为本地登录入口；未提供独立 AI 配置时，可以先开发不依赖模型的页面和 Excel 导入功能。

## 修改和查看效果

沿用现有架构、锁文件、权限及住宅／商业业务差异，只修改当前任务需要的内容。先复现反馈，再修改并核对保存、刷新回读与最终展示；界面改动实际查看不同窗口尺寸，不以测试通过代替观看效果。

Compose 将源码打入镜像，修改前端或服务代码后重建 API，再保存页面中未提交内容并刷新浏览器：

```sh
docker compose up -d --build --wait api
```

已有数据库卷不会自动重跑初始化 SQL。涉及结构升级时按 [数据库升级](docs/MIGRATIONS.md) 使用隔离数据验证，说明所需迁移、兼容和回退影响。不要将 `docker compose down -v` 当作日常更新或修复命令，也不要连接正式数据库进行测试。

## 验证与提交

先选择与改动有关的既有测试，保留实际失败路径、权限及旧状态断言。例如修改管理员批量撤回时，可运行：

```sh
node --test --test-concurrency=1 tests/admin-plan-batches.test.mjs tests/admin-plans-route.test.mjs
```

结构初始化改动应运行 `npm run test:db`；跨模块、认证或共享契约改动按风险扩大检查。`npm test` 提供整套测试入口，不要求每个文案或样式改动都重复全量运行。测试使用匿名和可丢弃数据；需要浏览器的用例还应按其夹具要求准备可用浏览器。未完成的验证明确记录，不能写成通过。

既有浏览器夹具使用 Microsoft Edge（`channel: 'msedge'`）。先检查是否已安装；缺失时按系统安装Edge，或使用 `npx playwright install msedge`（部分系统需要安装权限）。不能因缺少浏览器而跳过后声称UI测试通过；日常打开本地预览可用现代浏览器。

`.gitignore` 使用逐文件白名单。新增源码先检查内容，再加入准确例外；不要用强制添加绕过范围。只暂存本次审阅过的文件，完成以下检查后提交：

```sh
npm run check:source
git diff --check
git diff --cached --stat
git diff --cached
git commit -m "Describe the resulting change"
git push -u origin codex/your-task
```

在 GitHub 创建目标为本仓库 `main` 的 PR。没有仓库写权限时从自己的 Fork 创建 PR；认证失败应处理本人的 GitHub 权限，不索取或提交正式环境密钥。检查器不能代替人工审阅，真实业务样表、人员名单、`.env`、数据库备份、附件、演示账号文件和含这些内容的截图都不提交。

## 交回与部署

PR 应写明用户看到的问题、修改后的行为、复现及验收步骤，附匿名页面的前后截图或短视频，并列出实际执行的检查、未验证项、提交编号及数据库升级或配置影响。效果截图可附在 PR，不必为此向源码仓库加入业务图片。

本地效果达到用户要求后，把 PR 链接、最终提交编号和预览说明交回用户，供其确认效果并转回维护窗口。维护 Agent 核对最新源码与实际运行版本，审查必要修复、完成相关验证，再按有效授权合并和部署。开发 Agent 负责本地开发与提交 PR，不操作线上服务、不自动合并或触发部署；普通 Git 推送不会自动更新业务服务。

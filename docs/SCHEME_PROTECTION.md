# 方案原件保护与关键摘图

方案资料中心只展示已整理的指标、概要、差异和固定总图关键区域。原物理页码作为来源文字保留，不打开完整PDF、不向浏览器发送全文页索引。普通周报附件、独立项目图纸和资料共享继续遵守各自的权限与下载规则。

## 保护边界

- `/api/db`和管理档案读取都会去除方案原件URL、原件摘要、整页预览URL及`pages[].text`。浏览器只拿必要摘录、页数和受控摘图地址。
- 旧原件和整页预览路径由上传目录内的独立保护登记控制，不能通过修改普通档案解除。即使知道旧URL，原件读取仍被拒绝。
- 关键图接口只接受项目和已登记图片摘要。接口不接受任意页码、源文件或裁剪坐标；图片缺失或登记异常时明确不可用，不退回整页。
- 实际裁剪在离线准备阶段完成。浏览器接收的字节已经剔除整页其他区域，不依赖CSS遮盖原图。
- 原PDF和旧整页图保存为认证密文，HTTP不提供原件解密入口。可见摘录和关键图仍可被浏览器保存；本功能保护完整原件，不承诺阻止截图。

## 离线准备

同事仍可交付一个私有原始迁移包。维护方在受控目录核验原包和线上项目映射，再准备保护材料；密钥由维护方独立保管，不放入原包、保护包、Git或普通日志。不要用公开仓库或公开Release传真实资料。

沿用已有安装环境，无新增依赖：

```powershell
node scripts/protect-scheme-materials.mjs --input <原始材料目录> --manifest <私有准备清单.json> --output <全新受控输出目录> --key-file <独立密钥文件> --create-key
```

只有首次明确创建密钥时使用`--create-key`。后续复跑使用原密钥；错误密钥、不同材料或不同裁剪清单不会覆盖已准备目录。输入与输出必须分离，不能包含对方；密钥文件必须在两者之外。原包与输入原件不会被改写。

准备清单使用目标线上项目ID，示例仅为匿名结构：

```json
{
  "version": 1,
  "projects": [{
    "project_id": "project-a",
    "source": {"path": "drawings/project-a/source.pdf", "sha256": "原PDF的64位十六进制摘要"},
    "preview": {
      "path": "drawings/project-a/overview.jpg",
      "sha256": "原预览的64位十六进制摘要",
      "width": 1000,
      "height": 800,
      "source_page": 3,
      "crop": {"left": 100, "top": 80, "width": 700, "height": 600}
    }
  }]
}
```

每个项目需实际查看总图后选择关键区域。裁剪坐标绑定输入图片摘要和原始像素尺寸；源图更新必须重新确认，不能沿用旧框猜测。`masks`可选，用源图像素矩形显式去除裁剪框内残留的非关键表格，不能遮掉建筑范围或改造业务信息。输出不放大原像素、不保留源图元数据。缺少有效裁剪就停止准备，不自动输出整页。

输出目录包含原相对路径下的密文、`scheme-previews/<项目>/<摘要>.webp`和`scheme-protection/registry.json`；`preparation.json`用于核对准备清单一致性。材料准备成功不等于已经上线，按项目现行发布流程核对最新运行文件、材料摘要和恢复条件后再部署。不得盲目覆盖整套上传卷或数据库。

## 密钥与恢复

加密采用Node内置AES-256-GCM：每个文件独立随机nonce，项目和原存储路径作为认证范围。封套为`ZHSCM001`、12字节nonce、密文和16字节认证标签。实现参考[Node.js Crypto文档](https://nodejs.org/api/crypto.html#class-cipheriv)。

`verifySealedSchemeFile`会完整认证密文并计算原文摘要，不向HTTP或日志返回原文字节。准备工具逐份核对该摘要与原清单，并验证已有输出的幂等性。保存密钥的受控备份和密文备份应分别管理；密钥丢失会使原件无法恢复。服务器运行时只服务派生图，无需加载解密密钥。

## 验证入口

```powershell
node --test tests/scheme-vault.test.mjs tests/scheme-materials.test.mjs tests/scheme-protection.test.mjs tests/project-knowledge.test.mjs
npm run check:source
```

使用匿名隔离数据库和可丢弃文件验证权限、已知旧链接、HEAD／Range、通用查询投影、档案保存回读、裁剪边界、错误密钥／篡改、无预览和普通图纸兼容。实际企业材料仅在私有目录检查裁剪效果与技术一致性；不因此重复已完成的业务内容验收。

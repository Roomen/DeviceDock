# 客户端离线依赖

固定版本的第三方前端资源随客户端打包，避免 CDN 延迟阻塞首屏。网页版继续使用原有 CDN；`stage-web.mjs` 只在打包副本中替换资源地址并移除网页访问统计。

`manifest.json` 记录页面原地址、包内路径与下载源。Bootstrap 5.2.3、lucide-static 1.62.0、xterm 5.5.0、addon-fit 0.10.0、JSZip 3.10.1、uPlot 1.6.32 的许可文件保存在各目录。lucide 用其图标字体（css + woff2，类名 `icon-<name>`），随包的 css 按仓库实际用到的图标名裁剪，新增图标后运行 `node desktop/scripts/lucide-subset.mjs <完整 lucide.css>` 重新生成。

升级时按清单中的精确版本下载资源，同步更新 `index.html` 与清单，并运行 `node --test desktop/scripts/localize-web.test.mjs`。构建不下载依赖；缺文件或新增未打包的远程引用会使构建失败。

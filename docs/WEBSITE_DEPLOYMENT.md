# 官网部署

官网为 `site/` 内的静态网站，无需构建桌面应用或安装前端依赖。

## 当前生产环境（2026-10-28）

- 主站：https://bandbuddy.cn/
- www：https://www.bandbuddy.cn/，301 跳转到 HTTPS 主站；HTTP 同样跳转 HTTPS。
- Wiki：https://bandbuddy.cn/wiki.html；兼容隐私页：`/privacy.html`。
- 服务器：`ubuntu@47.80.22.102`；管理命令使用 `sudo`，不使用 Vercel。
- GoDaddy：A `@` → `47.80.22.102`，TTL 600 秒；CNAME `www` → `bandbuddy.cn`。
- Nginx：复用现有 Docker 容器 `nginx`，保留其余站点。
- 网站版本目录：`/home/admin/apps/nginx/bandbuddy/releases/<UTC 时间戳>/`。
- 当前链接：`/home/admin/apps/nginx/bandbuddy/current` → `releases/20261028-015427`。
- 站点配置：`/home/admin/apps/nginx/conf.d/bandbuddy.cn.conf`；仓库模板：`deploy/website/bandbuddy.cn.conf`。
- 容器网站目录：`/usr/share/nginx/html/bandbuddy/current`。
- 主机 `/etc/letsencrypt` 挂载为容器 `/etc/nginx/ssl/host-letsencrypt`。不要使用旧主机的容器证书路径。
- SSH 私钥仅保存在本机 SSH 目录，不写入仓库、网站或发布包。

## 更新静态网页

本地预览：

```powershell
python -m http.server 8766 --bind 127.0.0.1 --directory site
```

检查桌面与手机的逐屏切换、明暗模式、粒子动画、下载链接、隐私弹窗和 Wiki 搜索。只打包公开文件：

```powershell
tar -czf bandbuddy-site.tar.gz -C site index.html wiki.html privacy.html main.js home.js theme.js wiki.js wiki.css privacy.js styles.css home.css robots.txt sitemap.xml assets
scp -i <本机私钥路径> bandbuddy-site.tar.gz ubuntu@47.80.22.102:/home/ubuntu/
```

登录后使用 sudo 创建版本目录，校验文件并原子替换 `current`；保留旧版本供回滚。以下在管理员 shell 中执行：

```sh
set -eu
site=/home/admin/apps/nginx/bandbuddy
release=$(date -u +%Y%m%d-%H%M%S)
old=$(readlink "$site/current")
mkdir -p "$site/releases/$release"
tar -xzf /home/ubuntu/bandbuddy-site.tar.gz -C "$site/releases/$release"
find "$site/releases/$release" -type d -exec chmod 755 {} +
find "$site/releases/$release" -type f -exec chmod 644 {} +
test -s "$site/releases/$release/home.css"
test -s "$site/releases/$release/home.js"
ln -s "releases/$release" "$site/current.next"
mv -Tf "$site/current.next" "$site/current"
if ! curl --fail --silent --show-error --resolve bandbuddy.cn:443:127.0.0.1 https://bandbuddy.cn/ -o /tmp/bandbuddy-live.html; then
  ln -s "$old" "$site/current.rollback"
  mv -Tf "$site/current.rollback" "$site/current"
  exit 1
fi
sha256sum "$site/current/index.html" /tmp/bandbuddy-live.html
```

静态文件更新不需要重启 Nginx。修改站点配置前，先备份到 `conf.d` 以外的位置；`sudo docker exec nginx nginx -t` 通过后再执行 `sudo docker exec nginx nginx -s reload`。不要修改其他站点。

## HTTPS 与自动续期

新服务器已签发独立的 Let's Encrypt 证书，覆盖根域名和 www，当前有效期至 2027-01-25。主机证书目录为 `/etc/letsencrypt/live/bandbuddy.cn/`。证书验证方式为 webroot：

```sh
sudo certbot certonly --non-interactive --webroot -w /home/admin/apps/nginx   --cert-name bandbuddy.cn -d bandbuddy.cn -d www.bandbuddy.cn --keep-until-expiring
```

使用服务器已有 Certbot 账户。`certbot.timer` 已启用且 active。部署钩子 `/etc/letsencrypt/renewal-hooks/deploy/50-bandbuddy-nginx` 来自 `deploy/website/renew-nginx.sh`，root 所有、755 权限、LF 换行；只在 BandBuddy 域名续期时验证并重载 Nginx。

```sh
sudo certbot renew --cert-name bandbuddy.cn --dry-run --no-random-sleep-on-renew
sudo env RENEWED_DOMAINS='bandbuddy.cn www.bandbuddy.cn' /etc/letsencrypt/renewal-hooks/deploy/50-bandbuddy-nginx
systemctl status certbot.timer --no-pager
```

2026-10-27 模拟续期和钩子检查均通过。HTTP `/.well-known/acme-challenge/` 保持公开，其余 HTTP 请求跳转 HTTPS。

## 最近迁移与验证

- 新版清冷配色、原版 Logo、三维粒子双琴 / 鼓组 / 键盘已发布。发布包 SHA-256：`b3154e439e712205a7607596bde2d5a9a03c8035a04ca46401ba602ee479893f`。
- 新主机准备目录 `/home/ubuntu/apps/bandbuddy/staged` 保留，实际 Nginx 服务使用上述 `/home/admin/apps/nginx/bandbuddy/current`。
- 迁移配置备份：`/home/ubuntu/bandbuddy-migration-backups/20261027-054402`。既有 fbi、lovestudio、stock 三个站点配置哈希均未变化。
- 迁移时临时复制旧站有效证书，验证新 IP 的 HTTPS 后切换 A 记录；随后新主机独立签发证书并接管续期。
- GoDaddy 两个权威 DNS、Cloudflare 1.1.1.1 与 Google 8.8.8.8 均已返回新 IP。独立外部主机通过普通域名请求验证主站及 www 跳转、Wiki 与页面哈希；证书验证未禁用。
- 新主机 HTTPS 浏览器检查覆盖 1440×900 和 390×844，逐屏、滚轮、键盘、主题、隐私和 Wiki 搜索通过。另有本地 1280×720、375×667、320×568、触摸、延迟加载与完整旋转检查。
- 迁移后本机 Windows / Codex 浏览器的直接连接仍出现 TLS 断连，而外部正常解析的连接通过；本机此前也曾在指定新 IP 时收到旧 Nginx 响应，疑似本机代理或 DNS 缓存仍使用旧路由。不能把本机缓存刷新前的失败误认为新源站故障。
- 旧服务器 `82.156.187.130` 和版本 `20261027-032503` 保留为回滚来源，未删除服务。旧主机在大陆，域名未备案导致过公网访问问题；用户已指定迁移新主机。

## 内容与素材维护

主页与 Wiki 以桌面 3.0.0 对比上一公开版本 2.0.3；Android 和 iOS 独立迭代。八屏为首页、分轨练习、练功房、军火库、录音排练、更新、下载、社群。极矮视口允许屏内阅读，避免裁切文字。

Wiki 军火库包含 `#amp-models`、`#cab-models`、`#builtin-irs`、`#amp-setup`，介绍 5 款原生箱头、7 款物理箱体、72 条内置 IR。维护时核对 `packages/shared/src/amp-cab-catalog.ts`、`effect-identities.ts`、`docs/amp-cab-models.md` 与 `resources/cabinet-irs/README.md`；历史兼容型号不属于当前新建列表。

粒子舞台说明见 `deploy/website/hero-art.md`。责任与隐私正文共用 `site/privacy.js`。主题与动画偏好仅保存在浏览器本地，网站没有新增统计脚本。

## Android Wiki 与标题更新（2026-10-27）

官网页签、Open Graph 分享标题及首屏标识不再附带软件版本号；发布版本保留在更新内容中。Wiki 新增 `#android-start`、`#android-separation`、`#android-practice`、`#android-dojo`，覆盖安装与曲库、六轨与细分、练习与歌词、独立练功房与私有存储。

内容核对来源为 Android 项目的 `app/build.gradle.kts`、`ui/BandBuddyApp.kt`、`ui/DetailControls.kt`、`ui/ModelManagement.kt`、`ui/MetronomeSettingsDialog.kt`、`ui/DojoScreen.kt`，以及 `docs/dojo-android.md`、`docs/guitar-android.md`、`docs/vocal-android.md`。当前可见变速控件范围为 0.5×–1.5×；没有分轨／混音导出入口。未把未接入 UI 的人声质量组件写成用户可操作入口。

本次仅更新官网，未修改或重新验证 Android 应用。静态链接与锚点检查、1440×900 / 390×844 浏览器标题、目录跳转、章节搜索、主题切换及横向溢出检查通过，无浏览器运行错误。新版本目录为 `20261027-055847`，旧版本保留；生产 HTTPS 返回的首页与 Wiki SHA-256 与本地一致。

## 分平台 Wiki（2026-10-28）

Wiki 通过 PC / Android / iOS 按钮选择平台，仅显示该平台的正文和目录，搜索只匹配当前平台。支持 `?platform=pc|android|ios`；旧章节锚点（包括 `#amp-models`、`#android-practice`）自动选择所属平台。切换清空搜索，浏览器前进／后退与刷新保留 URL 指定的平台；打印不包含其他平台内容。

PC 18 章、Android 4 章、iOS 11 章。已清除 PC 章节中混杂的移动端说明。iOS 以 `dourgey/Bandbuddy-iOS` 提交 `e1d33e84b4d6a73f44dd183404f6cfec4b4157e9` 为依据，核对 `ContentView.swift`、`UI/ImportSheet.swift`、`PracticeView.swift`、`LiveHouseView.swift`、`SettingsView.swift`、`MixdownExportSheet.swift`、`App/AppModel.swift`、`Engine/VocalModelSpec.swift`、`GuitarModelSpec.swift`、`MixdownExporter.swift`、`Data/LANDownloadCoordinator.swift` 及 `Docs/Dojo/README.md`、`Docs/iCloudSync.md`。README 中旧人声模型体积不作为当前说明，使用 KARA_2 实际清单约 50.3 MiB。指南说明当前源码功能，未声明所有功能已随 App Store 版本发布。

新增样式 `site/wiki.css` 必须一起打包部署。浏览器验证使用现有 Playwright / Edge（Browser plugin not available）：1440×900、390×844、320×568 下检查页面标题、平台内容隔离、搜索与空结果、目录、嵌套旧锚点、查询参数、刷新、历史导航、键盘按钮、明暗模式、打印隔离和横向溢出；控制台无错误。未运行 iOS 真机测试，本次只更新官网。

发布目录 `20261027-164823` 为 UTC 时间戳（北京时间 2026-10-28）。源站与独立外部主机通过 HTTPS 校验 HTML、JS、CSS 哈希与本地一致，www 保留原路径并跳转主站。旧发布目录保留供回滚。

## iOS 公开说明调整（2026-10-28）

iOS 仓库为私有仓库，官网不公开该仓库地址、来源说明或 Issues 链接。iOS Wiki 保留全部 11 个功能章节，反馈入口改为 QQ 群；PC 与 Android 的公开仓库入口保留。已扫描公开 site 文件并验证平台切换时的反馈链接与文案。发布目录为 `20261028-015427`，公网 HTTPS 返回的 HTML、JS 哈希与本地一致。

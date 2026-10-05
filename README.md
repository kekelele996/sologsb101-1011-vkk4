# sologsb101-1011 水文站流量测验与绳套曲线台

面向水文站测验与资料整编人员的纯前端单页应用：把每次测流的测站、断面测次、垂线测深、流速测点逐层落档，据此整理水位—流量关系点据完成幂函数定线，并开展比测偏差分析。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22811**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22811），如需换端口改这一个变量即可。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5（Composition API + `<script setup>`） | 页面全部按路由懒加载 |
| 语言 | TypeScript 5.7（strict） | 构建脚本执行 `vue-tsc --noEmit` 类型检查 |
| UI 组件 | Element Plus 2.9 + @element-plus/icons-vue | 中文语言包，表格 / 表单 / 弹窗 / 徽标 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Pinia 2（setup store） | `stationStore` / `sectionStore` / `ratingStore` |
| 路由 | Vue Router 4（history 模式） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbhydrogaug`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 测站台账 | Station、Section、StageSegment、Rating | 新建/编辑/删除测站，按河名与集水面积分档筛选，卡片回显测次数、最新挂接水位与比测合格率 |
| `/stage-segments` | 水位站过程段 | StageSegment、Section、Rating | 维护过程段起止时刻与逐时读数，空读数显式保留，补录后自动重取挂过该段的点据水位 |
| `/stations/:id/sections` | 断面测次、测流时段与挂接重试 | Section、Station | 新增测次（测次号、起点距、测流起止时刻、实测流量、测法），按覆盖时段挂接水位，缺段/空读数挂起 |
| `/sections/:id/verticals` | 垂线布设与测深 | Vertical、Section | 起点距排序校验（重复即时告警）、按测点数自动生成测点行、部分面积法断面流量成果 |
| `/verticals/:id/points` | 流速测点录入 | Point、Vertical | 逐点录入相对水深与流速、批量粘贴导入、批量改写流速、权重归一、垂线流速分布图 |
| `/ratings` | 水位流量关系点据与定线 | Rating、RatingVersion、Compare | 挂起点据保留但不参与幂函数定线；工作线重算、超限点挂红、定案版本冻结，补录不回改已定案版本 |
| `/export` | 比测偏差分析与导出 | 全部模型 | 按测站出检测结论、比测偏差分析清单、全量 JSON 导入导出、清空重建演示数据 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该 id，页面渲染 `<RouteMissingPanel>` 友好空态（含返回入口与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1011/
├── README.md
├── docker-compose.yml          # name: gbhydrogaug，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = vue-tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 挂载 Pinia / Router / Element Plus，并打开并播种数据库
        ├── App.vue             # 顶部导航 + 上下文快捷入口 + 页脚数据概览
        ├── env.d.ts
        ├── types/              # station / stageSegment / section / vertical / point / rating / compare / filter
        ├── stores/             # stationStore / stageStore / sectionStore / ratingStore
        ├── components/common/  # DeviationTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useRatingFit
        ├── pages/              # StationList / StageSegmentList / SectionList / VerticalBoard / PointEntry / RatingChart / ExportView
        ├── router/index.ts     # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # flow.ts / stageLink.ts / db.ts / export.ts
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22811
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbhydrogaug`，当前结构版本 `v3`。页面侧由 `frontend/src/utils/db.ts` 统一封装，页面组件不直接触碰 Dexie 实例。
- **数据表**：`stations`（测站）、`stageSegments`（水位站过程段与逐时读数）、`sections`（巡测断面测次与测流时段）、`verticals`（垂线）、`points`（流速测点）、`ratings`（水位流量关系点据）、`ratingVersions`（已定案定线快照）、`compares`（比测记录）。
- **挂接规则**：整编定线前由巡测队按测流时段对账，只使用完整覆盖该时段且读数完整的过程段；缺段或空读数的点据挂起，不用邻段水位顶替。水位站补录后，挂过该段的点据自动重新取水位；挂接失败的重试仍由巡测队发起。已定案定线保存为 `ratingVersions` 快照，不随后续补录回改。
- **升级迁移**：`db.version(1)` 保留初版结构，`db.version(2)` 补齐历史索引，`db.version(3).stores(...).upgrade(...)` 增加水位过程段、测流时段、点据挂接状态与定案版本表；调整字段结构时递增 `DB_VERSION` 并在 `upgrade` 中补迁移。
- **首屏播种**：`initDatabase()` 在 `stations` 表为空时执行幂等播种，生成 3 个测站 / 10 个水位过程段 / 10 个断面测次 / 8 条垂线 / 26 个流速测点 / 15 个关系点据（其中 2 个挂起点据）用于演示缺段、空读数、补录重取与定案冻结。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，store 里的列表自动刷新，无需手动处理刷新时机。
- **备份与恢复**：`/export` 页可导出包含八张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id）」两种模式；备份时间写入 `localStorage`。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器 / 清空站点数据后数据不会跟随，需通过 JSON 备份迁移。

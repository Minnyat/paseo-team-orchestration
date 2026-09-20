# WebUI architecture — CLI là nguồn sự thật

Thiết kế lớp WebUI của `paseo-team-orchestration`. WebUI **không phải** một ứng dụng độc
lập: nó là phần mở rộng cài thêm cho CLI `paseo-team`, và mọi thao tác đọc/ghi
đều đi qua CLI đó.

```text
Browser (SPA)  --HTTP/JSON-->  webui/server.mjs  --spawn argv-->  paseo-team <cmd> --json
                                (transport only)                    |
                                                                    +--> file I/O  (cli/lib/config-walker.mjs)
                                                                    +--> paseo CLI (cli/lib/paseo-bridge.mjs)
                                                                    +--> scripts/* (preflight, watchdog, remote-paseo)
```

Quy tắc cứng:

- `webui/server.mjs` **không** import `config-walker.mjs`, không `readFile`,
  không gọi `paseo` trực tiếp. Nó chỉ map `route -> argv template` rồi spawn.
- Mọi tham số từ browser được validate theo allowlist **trước khi** trở thành
  phần tử argv. Không bao giờ ghép chuỗi shell (`shell: false` tuyệt đối).
- Mọi response của CLI là một JSON object duy nhất. Server trả nguyên văn
  stdout kèm `{ exitCode, stderr }` khi lỗi — không diễn giải lại.
- SPA hiển thị được **đúng câu lệnh CLI** vừa chạy cho mỗi hành động. Đây là
  thứ làm cho "CLI-as-truth" kiểm chứng được, chứ không chỉ là khẩu hiệu.

## 1. Ba mặt phẳng

WebUI phục vụ ba loại dữ liệu có nhịp sống rất khác nhau; trộn chúng vào một
màn hình là sai lầm thiết kế phổ biến nhất ở lớp này.

| Mặt phẳng | Nguồn | Nhịp | Ghi |
|---|---|---|---|
| **Config** | file trong `~/.pi`, `~/.paseo`, `~/.paseo-pi-team` | thay đổi hiếm | full-JSON qua stdin, atomic + backup |
| **Permission** | daemon Paseo (`paseo permit`) + policy tĩnh của role | giây, đang chặn agent | hành vi có thẩm quyền, cần audit |
| **Observability** | daemon Paseo (`ls`/`inspect`/`logs`) | 2-5s | chỉ đọc + gửi prompt |

### "Cấp quyền" là hai thứ khác nhau

Phải tách bạch trong UI, vì nhầm lẫn chúng là lỗi bảo mật:

1. **Runtime permit** — agent đang bị chặn ở một tool call cụ thể, cần người
   duyệt *ngay bây giờ*: `paseo permit ls|allow|deny`. Phạm vi: một request id.
2. **Policy authority** — role đó *về nguyên tắc* được làm gì: bảng allowlist
   trong `extensions/paseo-team-policy.ts`, biến môi trường
   `PASEO_TEAM_LEAD_WRITE` / `PASEO_TEAM_EXTRA_TOOLS`, và các trường authority
   của task brief V3 (`templates/TASK_BRIEF_V3.md`). Phạm vi: cả một lượt chạy.

WebUI hiển thị (2) ở dạng chỉ-đọc-có-giải-thích (render từ chính bảng policy),
và cho sửa qua env/prompt/brief. Không có nút "cấp full quyền".

**Ngoại lệ duy nhất, có chủ đích: tab "Ghế tuỳ biến"** (section `seats`) tạo ra
authority thật — nó sinh provider Paseo mang `PASEO_TEAM_EXTRA_TOOLS` /
`PASEO_TEAM_LEAD_WRITE`. Ba ràng buộc giữ nó nằm trong tinh thần trên:

- Người dùng chọn **năng lực** trong danh mục `scripts/seat-profiles.mjs`, không
  bao giờ gõ tên tool. Trình duyệt không có đường nào cấp một tool mà code chưa
  duyệt — cùng lời hứa mà `config-schema.mjs` đã giữ cho các trường cấu hình.
- Mỗi năng lực tự khai vai trò gốc và runtime family nhận được nó, nên UI không
  chào một quyền mà `seats apply` sẽ từ chối.
- Ghi provider là một hành động **riêng** (`POST /api/seats/apply`), không đi kèm
  thao tác lưu file, và chỉ đụng những tên có trong sổ cái nó tự tạo.

## 2. Bề mặt dữ liệu thật của Paseo (đã probe, CLI 0.3.0)

Xác minh trực tiếp trên daemon local, không suy đoán từ tài liệu:

```text
paseo status --json      -> daemon, listen addr, provider đã cài + version
paseo ls --json [-g][-a] -> [{ id, shortId, name, provider, thinking, status, cwd, created }]
paseo inspect <id> --json-> { Id, Name, Provider, Model, Status, Mode, Cwd,
                              CreatedAt, UpdatedAt, Capabilities, AvailableModes,
                              PendingPermissions[], Worktree, ParentAgentId }
paseo permit ls --json   -> [] (pending permission toàn cục)
paseo permit allow|deny <agent> [req_id]
paseo logs <id> [--tail n] [--filter tools|text|errors|permissions] [-f]
paseo attach <id>        -> stream output của agent đang chạy
paseo send <id> --prompt ...
```

Hai trường quan trọng nhất cho đồ thị: `ParentAgentId` (cạnh spawn) và
`PendingPermissions` (badge cảnh báo trên node).

> **Ràng buộc đã xác nhận bằng thực nghiệm:** `paseo logs <id>` phải hỏi phiên
> provider bên dưới; với agent `idle` lâu ngày nó trả
> `Failed to get logs: Pi RPC request timed out for get_state`. Timeline
> **không** phải dữ liệu luôn có. Bộ thu thập phải time-box từng agent, cô lập
> lỗi, và đánh dấu `logsOk: false` thay vì làm hỏng cả đồ thị.

## 3. Contract CLI cần bổ sung

CLI hiện có: `status`, `preflight`, `config read|write`, `prompts read|write`,
`skills list|read|write`, `env list`, `install`. Bổ sung (giữ nguyên phong cách
một-JSON-object-mỗi-lệnh):

```text
paseo-team config read|write pi-settings       -> ~/.pi/agent/settings.json (file riêng của Pi; ghi nguyên file + backup)
                                               -> response kem `schema`: bang field (label/hint/default/enum/min/max)
                                                  de WebUI render form; field nao CLI khong mo ta thi UI khong hien thi
paseo-team config read routing|cluster [--no-discovery]
                                               -> schema kem inventory that. Hai loai `optionsBy`:
                                                  `source: "models"` = danh sach model cua tung role provider, do
                                                  CLI do daemon roi bom vao luc read; khong co `source` = bang tinh
                                                  (muc thinking theo family). Trinh duyet van chi render nhung gi
                                                  CLI mo ta. Danh sach runtime rong (daemon chet) -> o do lui ve
                                                  nhap tay, khong bao gio thanh dropdown trong.
                                                  --no-discovery: bo qua daemon, doc thuan file
paseo-team config read|write seats             -> ~/.paseo-pi-team/seat-profiles.local.json (ghe tuy bien)
                                               schema mang danh muc nang luc tu scripts/seat-profiles.mjs;
                                               field `capabilities` la type "flags" (mang id), optionsBy
                                               phu thuoc sibling `base` -> nang luc vai tro goc khong nhan
                                               duoc thi KHONG hien ra
paseo-team seats list                          -> { seats, providers sinh ra, catalog, ledger, errors[] }
paseo-team seats apply [--dry-run]             -> merge provider vao ~/.paseo/config.json (atomic + backup).
                                               Chi go provider co ten trong so cai
                                               ~/.paseo-pi-team/seat-providers.json; ten trung do nguoi viet
                                               tay -> bao `skipped`, khong bao gio ghi de.
                                               Tai lieu ban dau: docs/claude-runtime.md + README (Custom seats)
paseo-team agents [--all]                      -> node list chuan hoa + role suy ra tu provider
paseo-team agent inspect <ref>                 -> inspect + pending permit + parent
paseo-team agent send <ref>                    -> prompt qua stdin -> file -> paseo send --prompt-file
paseo-team permits list                        -> pending permit + hang khong phan loai duoc
paseo-team permits allow|deny <agent> <reqId>  -> ghi audit roi delegate
paseo-team models [--provider <role-provider>] -> model that su co cua tung role provider (ca hai family).
                                               Khong co --provider: 1 lan `provider ls` + 1 lan `provider models`
                                               MOI FAMILY (dai dien = role provider dau tien dang bat va khoe),
                                               ket qua trai deu cho ca 3 vai tro cua family do.
                                               Co --provider: doc dung provider ay, kem thinkingOptionIds.
                                               Khong bao gio nem loi: daemon chet -> providers rong + degraded[]
paseo-team graph [--all] [--max-inspect <n>] [--refresh]  -> { nodes, edges, permits, degraded[] }
paseo-team watchdog [--stale-after <ms>]       -> delegate scripts/watchdog.mjs
paseo-team web [--port <n>] [--open] [--no-token]         -> khoi dong webui/server.mjs
paseo-team update [--check]                      -> so version package.json voi tag GitHub moi nhat (git ls-remote, khong dung npm view vi package khong bao gio len npm registry)
paseo-team uninstall [--purge]                   -> dao nguoc install: chi xoa dung cac item pack so huu (prompt/3 file, skill/2 thu muc, policy, team-scripts, va entry MCP "agent-browser" con sot lai tu ban cu); --purge moi xoa ~/.paseo-pi-team (kem audit log). Pack khong con cai browser rieng: ca hai runtime dung browser san co (Paseo Browser Control, Claude in Chrome)
```

Nguyên tắc tái sử dụng — repo đã có sẵn, **không viết lại**:

- `scripts/preflight.mjs` — gate cấu hình.
- `scripts/watchdog.mjs` — `classifyStaleAgents()`, fan-out `inspect` có giới
  hạn đồng thời (`DEFAULT_INSPECT_CONCURRENCY = 6`) và deadline toàn cục. Đây
  chính là bộ khung sẵn có cho `graph`.
- `scripts/remote-paseo.mjs` — `buildArgv()` cho multi-host, đã có redaction
  endpoint bí mật. Host selector của WebUI phải chảy qua đây.
- `scripts/team-communication.mjs` — schema `PEER_MESSAGE_V1` (xem §5).

## 4. Tiến trình và transport

- `webui/server.mjs`: HTTP server zero-dep (`node:http`), bind **127.0.0.1**.
- Một nhịp poll của SPA = **một** lần spawn `paseo-team graph`, không phải N
  spawn cho N widget.
- v1 dùng **polling + cache phía server**, không dùng stream. `logs -f` và
  `attach` là tiến trình con sống dài; nuôi N tiến trình như vậy từ web server
  nhân bội các chế độ lỗi (zombie process trên Windows, backpressure, đứt SSE).
  `--follow` là follow-up sau khi v1 ổn, và chỉ cho *một* agent đang mở drawer.
- Server được phép **cache nguyên văn** stdout của CLI vài giây và **gộp**
  các request giống nhau đang bay (single-flight). Cả hai đều không bịa ra dữ
  liệu, nên vẫn nằm trong "transport-only". Ba tab mở cùng lúc tốn đúng một
  lần spawn.

### Chi phí thật (đo trên máy tham chiếu, Windows, paseo 0.3.0)

Con số này quyết định gần như mọi lựa chọn ở trên, nên nó được đo chứ không
ước lượng:

| Thao tác | Thời gian |
|---|---|
| `paseo --version` (chỉ khởi động tiến trình) | ~2.7s |
| `paseo ls -g --json` / `permit ls` / `inspect` | ~3.0-3.5s mỗi lệnh |
| `paseo-team graph` lần đầu (cache lạnh, 21 agent) | ~12s |
| `paseo-team graph` khi cache đã ấm | ~3.8s |
| `paseo-team preflight --json` | ~25-30s |
| `paseo-team models` / `config read routing` | ~7-11s (1 + so family lan spawn `paseo`) |

Chi phí nằm ở **khởi động tiến trình**, không phải ở truy vấn daemon: chạy
thẳng `node dist/index.js` thay vì shim `.cmd` không nhanh hơn. Hệ quả:

1. Poll floor là **5s**, không phải 2s.
2. `preflight` có timeout riêng (180s) và TTL cache dài (60s) — nếu dùng chung
   timeout 60s với các lệnh khác thì nó timeout ngay khi có một nhịp poll
   graph chạy song song (đã tái hiện trên trình duyệt).
3. Cây spawn phải được **cache**, nếu không mỗi nhịp poll tốn N x 3s.

### Cache cây spawn (`cli/lib/graph-cache.mjs`)

`paseo ls` **không** trả parent; chỉ `paseo inspect <id>` có `ParentAgentId`.
Dựng lại cây mỗi nhịp poll cho 21 agent là hơn một phút wall-clock cho một cấu
trúc gần như không đổi. Nên:

- parent được cache tại `~/.paseo-pi-team/graph-cache.json` kèm `checkedAt`;
- TTL 15 phút chứ không phải vĩnh viễn, vì `paseo agent detach` có thể xoá
  parent — một agent đã detach tự lành trong vòng một TTL thay vì hiện cạnh ma
  cho tới khi ai đó xoá cache bằng tay;
- mỗi lần chạy chỉ tiêu tối đa `--max-inspect` (mặc định 6) lần inspect, ưu
  tiên id chưa từng thấy → cache lạnh tự đầy sau vài nhịp thay vì chặn 60s;
- phần chưa kịp phân giải được báo ra ở `pendingParents`, UI hiển thị
  "đang dựng cây: còn N" thay vì vẽ một cây trông đã xong.
- Ghi config: browser gửi **full JSON** của section; CLI parse (fail sớm nếu
  JSON hỏng), backup `<file>.bak-<ts>`, ghi tmp rồi `rename` — không
  regex-patch, không merge từng field.

### Bảo mật (bắt buộc, vì UI này duyệt quyền và ghi config)

- Token per-run: `paseo-team web` sinh token ngẫu nhiên, in ra terminal, trao
  cho SPA qua URL **fragment** (`#token=...` — fragment không đi lên server,
  không vào access log). SPA lưu `sessionStorage`, gửi lại ở header
  `Authorization: Bearer`.
- Kiểm tra header `Origin`/`Host` để chặn DNS-rebinding. Không bật CORS.
- Không route nào nhận đường dẫn tuỳ ý. Section/role/skill đi qua allowlist và
  `safeName()` như CLI đang làm.
- Endpoint bí mật của host từ xa **không bao giờ** rời server; SPA chỉ thấy
  `hostId`.

## 5. Bài toán khó: dựng lại đồ thị liên lạc agent ↔ agent

Paseo cho sẵn **node** và **cạnh spawn**, nhưng *không* có API "liệt kê tin
nhắn giữa các agent" — `send` là fire-and-forget. Hai nguồn để tái dựng cạnh
tin nhắn, theo thứ tự độ tin cậy giảm dần.

(Nguồn tin cậy nhất trước đây là chat room, nhưng Paseo đã bỏ chat room ở 0.4.0
— PR #3053 upstream gỡ hẳn thay vì migrate — nên nó không còn tồn tại.)

**(a) Peer -> Lead — tin cậy cao nhờ wire format sẵn có.**
`scripts/team-communication.mjs` đã đóng gói mọi tin nhắn Peer gửi lên Lead
theo khối có header ổn định:

```text
PEER_MESSAGE_V1
KIND: question|blocked|dependency|progress
CORRELATION_ID: <token>
TASK_ID: <token>
FROM_AGENT_ID: <agent id>
```

Vì vậy chỉ cần parse timeline/prompt của **Lead** là dựng lại được cạnh
`peer -> lead` kèm `kind`, `taskId`, `correlationId` — không cần Paseo hỗ trợ
thêm gì. `kind` chính là màu của cạnh trong đồ thị (`blocked` = đỏ).

**(c) Lead -> Peer — tin cậy trung bình.** Suy ra từ `paseo logs <id> --filter
tools` của Lead: các lời gọi `send_agent_prompt` / `create_agent`. Phụ thuộc
vào `logs` vốn có thể timeout (§2), nên cạnh loại này luôn kèm
`confidence: "suspected"`, đúng idiom `confidence: "unknown"` mà
`watchdog.mjs` đang dùng.

Schema chuẩn hoá mà `paseo-team graph` trả về:

```jsonc
{
  "collectedAt": "<iso>",
  "nodes": [{ "id", "shortId", "name", "role", "provider", "model", "status",
              "cwd", "worktree", "parentId", "pendingPermissions": 0,
              "stale": false, "confidence": "suspected|unknown" }],
  "edges": [{ "type": "spawn|message", "from", "to", "kind", "taskId",
              "correlationId", "ts", "confidence" }],
  "events": [{ "ts", "agentId", "type", "summary" }],
  "degraded": [{ "agentId", "reason": "LOGS_TIMEOUT" }]   // không im lặng nuốt lỗi
}
```

`degraded[]` là bắt buộc: UI phải nói rõ "3 agent không lấy được timeline" thay
vì vẽ một đồ thị trông đầy đủ nhưng thiếu cạnh.

`role` suy ra từ tiền tố provider (`pi-supervisor/...` -> `supervisor`), đối
chiếu với `roleProfiles` mà `paseo-team status` đã trả về.

## 6. Màn hình

1. **Dashboard** — `status` + `preflight --json`: daemon, provider, đường dẫn
   nào có/thiếu, nút chạy lại `preflight --strict`.
2. **Config** — editor JSON theo section (`providers`, `routing`, `cluster`,
   `mcp`), kèm danh sách backup đã tạo.
3. **Roles & authority** — sửa `prompts/{supervisor,lead,peer}.md`, xem bảng
   tool allowlist render từ policy, chỉnh env knob, dựng task brief V3.
4. **Permissions inbox** — permit đang chờ, allow/deny một chạm, kèm ngữ cảnh
   (agent nào, tool gì, tham số gì) và nhật ký quyết định.
5. **Team graph** — đồ thị agent: node tô màu theo role, viền theo status, badge
   số permit đang chờ; cạnh spawn nét liền, cạnh message nét đứt có hướng và
   nhấp nháy khi có tin mới. Click node -> drawer timeline + ô gửi prompt. Đây
   là màn hình lý do tồn tại của WebUI.
6. **Chat rooms** — đọc/gửi trong room.

## 7. Rủi ro

| Rủi ro | Xử lý |
|---|---|
| `paseo logs` timeout với agent nguội (**đã tái hiện**) | time-box từng agent, báo `degraded[]`, đồ thị vẫn dựng từ `ls`+`inspect` |
| N spawn mỗi nhịp poll làm chậm trên Windows | gom vào một lệnh `graph` |
| Cạnh Lead->Peer là suy đoán | gắn `confidence`, không vẽ như sự thật |
| WebUI mở một cổng duyệt quyền | 127.0.0.1 + token + kiểm tra Origin |
| Hai tab cùng sửa một config | backup theo timestamp + so `mtime` trước khi ghi (`--if-unchanged`) |
| Schema Paseo đổi giữa các version | chỉ đọc field đã probe; thiếu field -> `null` + báo degraded, không crash |

## 8. Lộ trình

- **PR-1 — CLI observability** — *xong*: `agents`, `agent inspect|send`,
  `permits list|allow|deny`, `graph`, `watchdog`.
  Test: `test/paseo-bridge.test.mjs`, `test/graph.test.mjs`,
  `test/cli-contract.test.mjs`.
- **PR-2 — WebUI transport** — *xong*: `webui/server.mjs` (token, bảng
  route→argv, cache + single-flight) + SPA `webui/public/`.
  Test: `test/webui-server.test.mjs`.
- **PR-3 — Permissions inbox** — *xong*: màn hình duyệt quyền, hàng không phân
  loại được thì hiện nhưng không cho một-chạm, audit tại
  `~/.paseo-pi-team/permit-audit.jsonl`.
- **PR-4 — Cạnh message** — *đã gỡ*: từng chạy qua chat room
  (`pteam graph --with-chat <room>`), nơi `author` là agent id thật nên cạnh có
  `confidence: "confirmed"`. Paseo bỏ chat room ở 0.4.0, nên nguồn đó biến mất
  cùng với nó. `buildGraph()` vẫn nhận `messages` như một đầu vào, nhưng hiện
  không có producer nào. Drawer timeline per-agent vẫn chưa làm.
- **PR-5 — Multi-host** — *chưa*: host selector qua `remote-paseo.mjs`, endpoint
  bí mật không rời server.
- **Governance (PR-D) + bàn giao (PR-E)** — *xong* trong tab Team graph: lọc
  theo `team.domain`, băng cảnh báo chồng lấn jurisdiction, cạnh `fork` cho
  phiên bàn giao. Chi tiết:
  `docs/multi-supervisor-topology.md` §4.

Trạng thái hiện tại của đồ thị: node + cạnh **spawn** + badge permit là dữ liệu
thật; cạnh **message** không còn nguồn nào (chat room đã bị Paseo gỡ), và cạnh
message suy-đoán-từ-log vẫn chưa có (legend vẫn ghi rõ "suy đoán" để không ai đọc
nhầm một đồ thị thiếu cạnh thành một đội không nói chuyện với nhau).

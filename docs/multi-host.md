# Multi-host (N host) — routing và vận hành

Thiết kế N-host của role pack. Không có tên máy nào hard-code trong core
logic; mọi host là một entry trong file controller-local duy nhất:

```text
~/.paseo-pi-team/cluster-routing.local.json    (template: config/cluster-routing.example.json,
                                                validator: scripts/model-routing.mjs#validateClusterConfig)
```

Lead resolve route bằng
`resolveClusterRoute(cluster, hostId, MODEL_CLASS, inventory)` và gate bằng
`node scripts/preflight.mjs --strict --host-id <id>`.

> **Di trú:** host registry `hosts.local.json` (cùng flag `--hosts` và template
> `config/hosts.example.json`) đã bị **bỏ hẳn** — không còn được đọc ở bất kỳ
> đâu. Chuyển từng entry sang `hosts{}` của cluster file rồi xóa file cũ;
> preflight sẽ cảnh báo `hosts-config` chừng nào file cũ còn nằm đó.

## Tài nguyên thiết kế

Mỗi host trong cluster file có sáu trường:

```text
HOST_ID        key của hosts{} — trùng hostId trong model-routing.local.json của host đó
connection     { type: "local" | "remote", endpointEnv: <TÊN env var, không phải value> }
required       boolean BẮT BUỘC — strict preflight fail nếu required host mất endpoint
capabilities   ['git-read', 'git-write', 'docker', 'integration-test', 'focused-test',
                'independent-review', ...]
limits         { writers, readers } — trần concurrency (object rõ ràng)
routes         per-MODEL_CLASS route — CÙNG schema với model-routing.local.json
```

`connection.type: "local"` là daemon mà Lead nói chuyện qua MCP server được
inject (không cần endpoint). Endpoint VALUE (pairing offer / tcp URI) chỉ sống
trong env var được trỏ qua `endpointEnv`; file không bao giờ chứa secret.

Dạng endpoint được chấp nhận (parse-based validation, không character
whitelist): pairing offer URL `https://app.paseo.sh/#offer=...`, TCP URI
`tcp://host:port?ssl=true&password=...`, `https://...` URL, hoặc `host:port`
trần.

## Luồng host routing (mandatory order)

1. **Filter hard constraints** — loại host thiếu capability bắt buộc
   (writer scope cần `git-write`; cross-host review cần candidate
   `PUSHED_REMOTE` reachable từ reviewer host).
2. **Daemon reachable** — với host remote:
   `node scripts/remote-paseo.mjs health --host-id <id>`
   (không reachable → `HOST_ROUTE_UNAVAILABLE`, KHÔNG rơi về host khác
   ngầm nhiên; chuyển host phải là routing decision được ghi lại).
3. **Repository availability** — repo/project tồn tại trên host (workspace
   source path) hoặc clone/pull được.
4. **Model route hợp lệ trên host đó** — đọc route của host từ cluster file,
   verify `list_models` trên ĐÚNG daemon đích (cache inventory theo hostId,
   không theo provider name).
5. **Concurrency** — `limits.writers/readers`; một moving scope chỉ một
   writer toàn cụm, không phải chỉ một writer mỗi host.
6. **Chọn host và ghi routing evidence** (xem ROUTING_DECISION trong
   SKILL.md).

## Cơ chế tạo agent trên daemon khác

MCP server được inject vào pi agent **luôn trỏ daemon local** của agent đó
(xác minh bằng source Paseo 0.2.5: `daemon.mcp.injectIntoAgents` tạo mcp
config ở `createPiMcpConfigFile` với URL daemon của chính daemon cha).
`--host` là option của Paseo CLI, KHÔNG phải argument của MCP tool — nên với
host remote, Lead KHÔNG dùng MCP mà dùng **wrapper `scripts/remote-paseo.mjs`**
(Lead skill bắt buộc tách LOCAL_CREATE_CYCLE / REMOTE_CREATE_CYCLE).

Wrapper nhận `HOST_ID` từ cluster file, tự resolve `endpointEnv`, validate
provider/model/thinking, chạy Paseo CLI với `--host` (không shell-quoting
thủ công), và trả JSON envelope có gắn `hostId` — endpoint value không bao
giờ xuất hiện trong output hay error:

```bash
# Endpoint value NẰM TRONG ENV (ví dụ PASEO_HOST_B), cluster file chỉ tên:
node scripts/remote-paseo.mjs health --host-id <id>
node scripts/remote-paseo.mjs providers --host-id <id>
node scripts/remote-paseo.mjs models --host-id <id> --provider pi-peer
node scripts/remote-paseo.mjs workspaces --host-id <id>
node scripts/remote-paseo.mjs workspace-create --host-id <id> --path <path-on-remote> --title <t>
# MỘT workspace cho cả việc: lệnh này dùng lại workspace đang mở trên <path> (reused: true),
# chỉ tạo khi chưa có, và chỉ tạo local — `--isolation worktree` bị từ chối
# (WORKSPACE_ISOLATION_REFUSED). Reviewer tự `git worktree add --detach` bên trong
# workspace chung; không worktree được → BLOCKED: REVIEW_WORKTREE_UNAVAILABLE
node scripts/remote-paseo.mjs run --host-id <id> \
  --provider pi-peer/<pi-provider>/<model-id> --thinking <level> \
  --workspace <wks-id> --title <t> --brief <task-file>
node scripts/remote-paseo.mjs status --agent-ref <host-id>/<agent-id>
node scripts/remote-paseo.mjs send --agent-ref <host-id>/<agent-id> --prompt <text>
node scripts/remote-paseo.mjs cancel --agent-ref <host-id>/<agent-id>
node scripts/remote-paseo.mjs archive --agent-ref <host-id>/<agent-id>
```

Đủ chi tiết: `node scripts/remote-paseo.mjs --help`.

CLI chấp nhận `host:port`, socket/pipe, `tcp://host:port?ssl=true&password=...`
hoặc pairing offer URL (xem `paseo run --help`). Credential của endpoint sống
trong env, không trong file. Lưu ý: `paseo status` KHÔNG có `--host` — reachability
remote dùng `remote-paseo.mjs health` (chạy `paseo ls --host ... --json`).

> Lưu ý bảo mật policy: policy extension chặn Peer dùng `paseo` CLI từ
> bash (heuristic) và cho Lead quyền `bash`. Lead dùng wrapper cho remote được
> coi là đường orchestration chính thức — vẫn qua control plane Paseo, không
> phải control plane thứ hai.

**Multi-Lead vẫn là phương án mặc định cho quan hệ chặt lâu dài**: một Lead
mỗi daemon, Supervisor quan sát chéo và Human phối hợp portfolio. Cross-host
từ một Lead nên dành cho pattern nhẹ (reviewer host riêng, runner host riêng).

## Composite reference

```text
AGENT_REF      <host-id>/<agent-id>                    (vd: local/9cb42327-..., host-b/3fa8b20a)
WORKSPACE_REF  <host-id>/<workspace-id>
CANDIDATE_REF  <repository-url>@<commit-sha>
```

`CANDIDATE_REF` độc lập host: git SHA là điểm neo duy nhất giữa writer và
reviewer nằm hai host — vì vậy cross-host review **bắt buộc**
`COMMIT_AUTHORITY: allowed` + `PUSH_TASK_BRANCH_AUTHORITY: allowed` trong
brief của Engineer (push authority là branch-scoped: chỉ
`git push -u origin HEAD:refs/heads/agent/<TASK_ID>`, hoặc cùng lệnh đó với một
`-C <worktree-path>` đứng trước), và reviewer dùng fresh
clone/fetch tới đúng SHA.

## Failure & recovery

- **Daemon remote chết giữa task** → không tự spawn writer thay thế khi
  trạng thái writer cũ chưa rõ (có thể đã commit). Quy trình: đánh dấu
  HOST_ROUTE_UNAVAILABLE, chờ daemon quay lại, đối chiếu `git log`/`status`
  của workspace trên host đó, mới quyết định recreate + carry-over.
- **Writer không phản hồi** → Lead check qua
  `node scripts/remote-paseo.mjs health --host-id <id>` trước khi tuyên bố
  mất; nếu daemon sống mà agent kẹt →
  `node scripts/remote-paseo.mjs cancel --agent-ref <host-id>/<agent-id>`
  rồi archive (`archive --agent-ref ...`) và handoff scope (commit SHA cuối
  cùng = progress checkpoint).
- **Endpoint env mất** → strict preflight FAIL (warn trong non-strict);
  routing tới host đó là BLOCKED, không suy đoán endpoint từ lịch sử.

## Lab nhiều máy trên MỘT máy (tự động)

`scripts/lab/multihost-lab.sh` dựng N "máy" Paseo thật trên một host. Mỗi máy
có `HOME` riêng (nghĩa là `~/.paseo`, `~/.paseo-team-orchestration`, repo
`projects/demo` riêng) và daemon riêng trên một cổng TCP. Máy đầu là
controller (`connection.type: local`), các máy còn lại là remote với endpoint
trong `PASEO_LAB_<HOST>`. Role provider ở lab `extends: "acp"` và trỏ tới
`scripts/lab/fake-acp-agent.mjs`, một ACP agent giả. Nhờ vậy agent thật sự
được tạo, chạy turn, inspect, stop, archive trên đúng daemon đích mà không cần
API key. Mỗi host được gán một runtime family khác nhau (lab-b: claude,
lab-c: opencode).

```bash
npm i -g @getpaseo/cli
scripts/lab/multihost-lab.sh up            # [--hosts a,b,c] [--base-port 6801] [--root DIR]
scripts/lab/multihost-lab.sh test          # 31 check, exit 1 nếu có FAIL
eval "$(scripts/lab/multihost-lab.sh env)" # tự đóng vai controller, chạy tay remote-paseo.mjs
scripts/lab/multihost-lab.sh down
```

Scenario `scripts/lab/multihost-scenario.mjs` chỉ gọi tool đã ship
(`remote-paseo.mjs`, `model-routing.mjs`, `preflight.mjs`) và phủ:

- cluster file validate;
- health / providers / models theo đúng inventory của từng host;
- `preflight --host-id`;
- nhiều project trên một host: hai workspace, `workspace-create` dùng lại
  workspace có sẵn;
- Peer chạy song song trên hai host, mỗi host dùng route riêng của nó, và turn
  chạy đúng daemon đó (`LAB_ACK host=...`);
- không lẫn agent giữa các host;
- send / cancel / archive theo `AGENT_REF`;
- các lỗi phải bắt được: thiếu endpoint env, host lạ, host local bị từ chối,
  host chết thì báo `HOST_ROUTE_UNAVAILABLE` và không rơi sang host khác,
  host trở lại sau restart, daemon từ chối thì trả nguyên lý do của daemon.

Lab **không** thay thế được: mạng/TLS/password thật giữa hai máy, model thật,
và chuỗi Engineer → push → Reviewer clone đúng SHA (vẫn là test tay ở mục dưới).

### Lỗi do lab tìm ra và đã sửa

- Paseo 0.14 trả lỗi `--json` dưới dạng `{"error":{code,message}}` trên
  **stderr**. `remote-paseo.mjs` trước đây chỉ trả "Command failed: paseo
  …", làm mất lý do thật. Giờ envelope có thêm `paseoError: {code, message,
  details}`, và `message` là lý do của daemon (endpoint vẫn được redact).
- Host chết (`DAEMON_UNREACHABLE`) trước đây ra `CLI_ERROR` chung chung. Giờ
  nó ra `HOST_ROUTE_UNAVAILABLE`, đúng mã mà mục Failure & recovery bảo Lead
  dùng. Lỗi daemon từ chối (agent không tồn tại, mode sai) vẫn là `CLI_ERROR`.
- Redact thêm `password=…` và `#offer=…`. Lý do: thông báo lỗi của daemon có
  thể in endpoint đã chuẩn hoá, không còn khớp từng byte với giá trị trong env.

## Cross-host test plan (MANUAL — cần máy thứ hai)

Trạng thái (2026-08): **live remote preflight đã chạy qua relay offer**
(commit phase 6+). Full chuỗi Windows Engineer → Mac Reviewer → correction →
re-review CHƯA hoàn tất. Khi chạy đủ, ghi kết quả vào PR/issue liên quan:

1. `node scripts/preflight.mjs` PASS trên cả hai host (riêng biệt).
2. Host A: đặt `PASEO_HOST_B=tcp://<ip>:6767?ssl=true&password=...`;
   `node scripts/remote-paseo.mjs health --host-id <host-b-id>` reachable;
   `node scripts/preflight.mjs --strict --host-id <host-b-id>` PASS (remote
   inventory đúng host — cache theo hostId).
3. Host B cài role pack; routes của host B khác host A (đúng mục đích: N host
   có model mapping khác nhau).
4. Lead (host A) spawn reviewer trên host B:
   Engineer (A) được cấp COMMIT+PUSH → push đúng form
   `git push -u origin HEAD:refs/heads/agent/<TASK_ID>` tới remote chung
   → reviewer (B) clone/fetch đúng `CANDIDATE_SHA`, refuse nếu HEAD ≠ SHA.
5. Kill daemon host B giữa task writer → Lead báo `HOST_ROUTE_UNAVAILABLE`,
   không spawn writer thứ hai cùng scope.
6. `unknown` env endpoint → routing bị BLOCKED, không fallback về local.

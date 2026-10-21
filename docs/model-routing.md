# Model Routing — cấu hình, truyền và xác minh model

Tài liệu này mô tả kiến trúc model routing bốn lớp và cách vận hành **không
silent fallback**. Mọi command trong file đã chạy thật trên Paseo 0.2.5 +
Pi 0.83.0 + pi-mcp-adapter 2.19.0 (Windows host `desktop-m1a2r16`,
2026-08-04) trừ khi ghi khác đi.

## Bốn lớp

```text
Lớp 1  Pi model inventory (per host, KHÔNG commit)
         pi install, ~/.pi/agent/auth.json, credential env,
         ~/.pi/agent/models.json (custom provider/model), extension/package
         → với endpoint OpenAI-compatible: `pteam models sync` dựng lại file này
           (probe thật từng model; cờ `reasoning` suy từ câu trả lời, không đoán
           theo tên — đoán sai là Paseo báo thinkingOptions "none" và chặn mọi
           route trên mức off). Cấu hình ở ~/.paseo-pi-team/pi-models.local.json.
              │
Lớp 2  Paseo role profiles (commit template) — ĐÚNG 6 profile,
       một cho mỗi (family, vai trò):
         pi-supervisor / pi-lead / pi-peer          (extends "pi")
         claude-supervisor / claude-lead / claude-peer (extends "claude")
       cả sáu chỉ khác nhau ở env PASEO_PI_ROLE (+ disallowedTools bên claude)
              │
Lớp 3  Logical model classes (commit, trong repo):
         bắt buộc:  MONITOR_ECONOMY | FAST_READ | CODING_MEDIUM | REASONING_HIGH | REVIEW_HIGH
         tuỳ chọn:  SUPERVISOR_GOVERNANCE (route *-supervisor) | LEAD_RECOVERY (route *-lead)
              │
Lớp 4  Host-local route (KHÔNG commit):
         ~/.paseo-pi-team/model-routing.local.json
         CLASS → { paseoProvider, model, thinking }
         model và thinking theo family của paseoProvider:
           pi     → "<pi-provider>/<model-id>", off|minimal|low|medium|high|xhigh|max
           claude → "<model-id>" (một đoạn),    off|low|medium|high|xhigh|max|ultracode
         Một route có thể ở family này, route kế bên ở family kia, trên cùng máy.
```

Danh sách model của từng role provider đọc bằng `pteam models` (một lần
`provider ls` + một lần `provider models` mỗi family) hoặc
`pteam models --provider <role-provider>` để thấy kèm `thinkingOptionIds`.
Form định tuyến trong WebUI gợi ý đúng danh sách đó và giới hạn mức thinking
theo family — nhưng gợi ý không phải thẩm quyền: `resolveRoute` lúc preflight
mới là chỗ fail-closed.

**Quyết định có chủ đích:** không pin danh sách model vào Paseo provider
profile (dù `ProviderOverrideSchema.models` của Paseo 0.2.5 hỗ trợ). Lý do:
catalog model là host-specific; pin vào config chung sẽ cần một profile mỗi
model và nhân bản secret của môi trường lên repo. Model được chọn ở Lớp 4
và truyền exact lúc `create_agent`.

## Vì sao routing phải strict — ba silent-fallback đã xác minh

1. **Paseo ép thinking không hợp lệ về `medium` một cách âm thầm.**
   `PiRpcAgentClient.createSession` gọi
   `normalizePiThinkingOption(input) ?? "medium"` — truyền `thinking: "turbo"`
   chạy êm ở mức medium. Nguồn: `server/agent/providers/pi/agent.js`.
2. **Paseo `list_models` cho pi báo cả 7 thinking options cho mọi model
   `reasoning: true`**, bất kể `thinkingLevelMap` trong
   `~/.pi/agent/models.json`; pi docs nói rõ entry `null` nghĩa là level
   không được hỗ trợ và bị **clamp** (hidden/skipped/clamped away).
   → preflight cross-check `thinkingLevelMap` và cảnh báo.
3. **`--model` của pi là pattern** (docs pi, hỗ trợ `provider/id` và
   partial match). Model ID không chính xác có thể khớp model khác.
   → luôn truyền exact `provider/id`.

Cùng lắp ráp lại, **cơ chế bảo vệ là: pre-validate (list_models) + post-verify
(observed runtimeInfo)**. Khi model không tồn tại, pi fail với status `error`
(không rơi về model khác — đã verify live); nhưng thinking clamp và pattern
match **không** báo lỗi, nên observed-check là bắt buộc.

## Cổng route cho `create_agent` — routing được ép bằng code

Trước đây routing chỉ là quy ước: policy kiểm HÌNH DẠNG của `create_agent`
(có đoạn model, có `settings.thinkingOptionId`, có `settings.modeId`, có
`labels.purpose`, có `team.cluster`) nhưng không so provider/model/thinking với
route file. Một Lead có thể dựng Peer — và Supervisor dựng Lead — trên bất kỳ
model nào parse được. Cổng route đóng lỗ hổng đó, trong `policy-core.ts`, dùng
chung cho cả hai runtime (adapter Pi và hook Claude).

Cổng phủ **đúng ba lối** (và chỉ ba — xem "Known gaps" bên dưới):
`create_agent` qua MCP, `update_agent` qua MCP khi đổi model/thinking, và
`team_fork`. **Mỗi `create_agent` MCP của Lead hoặc Supervisor** phải khai lớp
model trong `labels["team.model-class"]`, và phải khớp route của lớp đó **trên
máy này**:

| So sánh | Quy tắc |
|---|---|
| provider head | viết đúng chữ thường, không khoảng trắng (`Claude-Peer`, ` claude-peer` bị từ chối kèm cách viết đúng); family+role phải bằng route (seat `claude-peer-audit` tính là claude/peer) |
| model | bằng `route.model` từng byte |
| thinking | `settings.thinkingOptionId` bằng `route.thinking` từng byte (Paseo âm thầm chạy level lạ ở `medium`) |

Thông báo từ chối luôn nêu giá trị mong đợi (`Expected provider "…" with
settings.thinkingOptionId "…"`). Provider không parse được bị từ chối, không
bao giờ bị bỏ qua.

**Lớp theo vai trò của ghế được dựng** — cùng một câu trả lời dù ai dựng, để
ghế quản trị và ghế khôi phục không bao giờ mượn route của Peer:

| Ghế được dựng (create_agent / team_fork) | Lớp được khai |
|---|---|
| Peer (Lead dựng) | `MONITOR_ECONOMY`, `FAST_READ`, `CODING_MEDIUM`, `REASONING_HIGH`, `REVIEW_HIGH` |
| Supervisor (Lead dựng) | `SUPERVISOR_GOVERNANCE`; ghế **quan sát** (`team.watch` hợp lệ, không có `decisions`) còn được `MONITOR_ECONOMY` |
| Lead (Supervisor recovery, Lead kế nhiệm, fork của Lead) | `LEAD_RECOVERY` |

**Ghế quan sát và lớp `MONITOR_ECONOMY`.** Một job dài có nhiều Supervisor, mỗi cái
một loại việc (`team.watch`, README "Several Supervisors on a long job"). Ghế quyết
định (không nhãn, hoặc nhãn có `decisions`) là ghế mà chất lượng suy luận quyết định
điều Human không bị hỏi, nên giữ `SUPERVISOR_GOVERNANCE`. Ghế chỉ quan sát — nhất là
loại cơ học như `liveness`, `cost` — được route từ `MONITOR_ECONOMY`, lớp vốn ghi là
"supervisor heartbeat, structured observation". Cổng nhìn vào `labels["team.watch"]`
của lời gọi `create_agent`: nhãn không đọc được không mua được route rẻ, và ghế quyết
định xin `MONITOR_ECONOMY` bị `ROUTE_CLASS_WRONG_FLOW`. Route của `MONITOR_ECONOMY`
vẫn phải trỏ tới provider `*-supervisor` (file mẫu đã vậy); nếu trỏ `*-peer` thì Lead
nhận `ROUTE_PROVIDER_MISMATCH` khi dựng Supervisor, y như chiều ngược lại ở trên.
Fork truyền nhãn mà bản sao sẽ mang, `update_agent` truyền nhãn `team.watch` đọc từ state
của chính ghế đích: ghế quan sát đang chạy `MONITOR_ECONOMY` vẫn được đổi model trong
route đó, còn ghế quyết định thì không bao giờ có lớp này. Gọi mà không biết gì về ghế
chỉ thấy `SUPERVISOR_GOVERNANCE`, lớp mà mọi Supervisor luôn có — không bao giờ mua route
rẻ bằng một lời đoán.

**`update_agent`** đổi `settings.model` và/hoặc `settings.thinkingOptionId` (kể
cả `null` — xoá về mặc định daemon) bị so với route của lớp **ghi trên chính
agent đích** (`labels["team.model-class"]` đọc từ state của Paseo trên máy),
không phải lớp khai trên lệnh update: nếu lấy lớp từ lệnh, Lead chỉ việc khai
lớp nào có route trùng model mình muốn. `update_agent` cũng không được đổi nhãn
`team.model-class` (`ROUTE_CLASS_IMMUTABLE`) — đổi lớp của một ghế = một
`create_agent` mới, tức là đi qua cổng. Agent đích không đọc được, không có lớp,
lớp chưa cấu hình, hoặc model/thinking lệch route → từ chối, nêu giá trị mong
đợi. `update_agent` chỉ đổi tên, nhãn khác, `modeId` hay `features` đi qua như
cũ, không đọc state.

**`team_fork`** bắt buộc `modelClass`, kiểm như `create_agent` theo vai trò của
fork, đóng nhãn `team.model-class` lên fork khi import, và lệnh `update_agent`
nó trả về mang đúng model/thinking của route. `verify` so với route của lớp ghi
trên fork (không so với giá trị người gọi nhắc lại).

**Một lớp route tới provider `*-supervisor` không dùng được để dựng Peer.** File
mẫu route `MONITOR_ECONOMY` tới `pi-supervisor` (giám sát thường ngày của
Supervisor do Human dựng), nên Lead dựng Peer với `MONITOR_ECONOMY` bị từ chối
`ROUTE_PROVIDER_MISMATCH` — muốn dùng lớp đó cho Peer thì route phải trỏ tới một
provider `*-peer`. Cùng lý do, lớp route tới `*-lead` không dựng được Peer.

**Hai lớp tuỳ chọn.** `SUPERVISOR_GOVERNANCE` và `LEAD_RECOVERY` không bắt buộc
trong route file — mọi file viết trước khi có chúng vẫn hợp lệ, preflight chỉ
cảnh báo. Khi luồng cần lớp chưa cấu hình, cổng từ chối
`ROUTE_CLASS_UNCONFIGURED` và nêu lệnh cấu hình
(`pteam routing set <CLASS> --provider <family>-<role> --model <id> --thinking <level>`).
Cổng **không** rơi về lớp khác: rơi âm thầm sang route khác chính là lỗi mà cả
repo này tồn tại để ngăn (xem mục ba silent-fallback ở trên). Validator còn bắt
`SUPERVISOR_GOVERNANCE` trỏ tới provider `*-supervisor` và `LEAD_RECOVERY` tới
`*-lead`.

**Cổng đọc file nào.** `create_agent` qua MCP luôn rơi vào daemon LOCAL, nên
cổng cần route của đúng một máy — máy này:

1. có `cluster-routing.local.json` → host DUY NHẤT có `connection.type: "local"`;
   không có host local nào → xuống bước 2; từ hai host local trở lên → từ chối
   (`LOCAL_HOST_AMBIGUOUS`);
2. ngược lại `model-routing.local.json`.

File không đọc được / sai schema, hoặc không có file nào → **fail-closed**: mọi
`create_agent` (và mọi `update_agent`/`team_fork` đổi model) của Lead/Supervisor
bị từ chối (`ROUTE_TABLE_UNAVAILABLE`) kèm đường dẫn file — nên preflight báo
**FAIL** (không chỉ WARN, kể cả khi không có `--strict`) khi cổng đang bật; khi
opt-out thì chỉ WARN. Cluster file sai **không** bao giờ khiến cổng quay sang đọc file
đơn-host. `pteam routing show` cho biết cổng đang đọc file nào.

**Opt-out duy nhất: `PASEO_TEAM_ROUTE_ENFORCE=off`** — đúng chuỗi `off`; mọi giá
trị khác (`OFF`, `0`, gõ sai) vẫn là bật. Chỉ dành cho khẩn cấp, không bao giờ là
mặc định, và được làm cho **ồn ào**: mỗi lượt của Lead/Supervisor trên cả hai
runtime nhận một khối cảnh báo, preflight báo WARN (FAIL với `--strict`),
`pteam routing show/check` gắn cờ.

### Known gaps — những gì cổng KHÔNG phủ

Cổng phủ `create_agent` MCP, `update_agent` MCP và `team_fork`. Nó **không** phủ:

1. **Lệnh `run` của `remote-paseo.mjs`** — tạo agent trên host remote qua Paseo
   CLI `--host`; không đi qua MCP của daemon local nên hook không thấy nó. Vì vậy nó cũng
   **không** thấy công tắc `enabled` của route (nó nhận provider tường minh, không qua resolver).
2. **Lead gọi thẳng `paseo` CLI từ bash** (tạo hay đổi agent với `--provider`
   tuỳ ý) — `callsPaseoCli` chỉ áp cho Peer. Có từ trước thay đổi này và nằm
   ngoài phạm vi của nó.
3. **Sửa tay state của Paseo trên đĩa** (`$PASEO_HOME/agents/*.json`) để đổi nhãn
   `team.model-class` rồi `update_agent` — cổng tin nhãn đó vì Paseo là nơi ghi
   nó; một seat có quyền ghi file ngoài repo vượt được.

Ba lối này là quy ước, không phải code: route lấy từ `pteam routing show`, và
`get_agent_status → runtimeInfo` vẫn là bằng chứng sau cùng.

## Cập nhật route bằng CLI

```bash
pteam routing show [--json]      # route hiệu lực theo lớp; đánh dấu lớp tuỳ chọn chưa đặt
pteam routing check [--json]     # phần routing của preflight: schema + resolve strict với daemon
pteam routing set <CLASS> --provider <role-provider> --model <id> --thinking <level> [--host-id <id>]
pteam routing unset <CLASS> [--host-id <id>]   # chỉ SUPERVISOR_GOVERNANCE / LEAD_RECOVERY
pteam routing enable|disable <CLASS> [--host-id <id>]   # công tắc nhanh, xem mục dưới
```

`set` kiểm route mới bằng `resolveRoute` ở chế độ **strict** với inventory sống
của daemon local (như `preflight --strict`) và **không ghi gì** nếu route không
resolve được. Mỗi lần ghi: chép file cũ sang `<file>.bak-<epoch>` rồi ghi
nguyên tử (file tạm + rename). Không có `--host-id`: sửa đúng file và host mà
cổng đọc. `--host-id <id>`: sửa host đó trong `cluster-routing.local.json`; host
`remote` bị từ chối vì inventory của nó nằm ở daemon khác — chạy lệnh trên chính
host đó, hoặc sửa file rồi `pteam preflight --strict --host-id <id>`. Thư mục
cấu hình theo cùng biến ghi đè với các lệnh khác (`PST_TEAM_CONFIG_DIR` /
`PASEO_TEAM_HOME`).

## Công tắc nhanh — tắt/bật một lớp, có hiệu lực ngay

```bash
pteam routing disable <CLASS> [--host-id <id>]   # route.enabled = false
pteam routing enable  <CLASS> [--host-id <id>]   # bỏ khoá enabled
```

Hoặc bật/tắt trong WebUI → Cấu hình → Định tuyến mô hình → "Công tắc nhanh" (cùng
đường ghi, cùng validator, cùng bản sao lưu với nút Lưu).

- Route tắt **vẫn giữ nguyên model và thinking** (bật lại là trở về đúng như cũ) và
  file vẫn hợp lệ — kể cả lớp bắt buộc.
- Cổng từ chối **mọi** lần dựng theo lớp đó — `create_agent`, `update_agent` đổi
  model/thinking, `team_fork` — bằng `BLOCKED: ROUTE_CLASS_DISABLED`, kèm lệnh
  `pteam routing enable <CLASS>`. **Không có fallback**: không sang lớp khác, không sang
  model khác (đúng nguyên tắc cả repo này tồn tại để giữ).
- `resolveRoute` ném `ROUTE_DISABLED`; preflight / `routing check` báo **WARN** (không
  FAIL, kể cả `--strict`: tắt là chủ ý, không phải lỗi). `routing set` đổi model của một
  lớp đang tắt vẫn giữ nó tắt.
- Agent **đang chạy** giữ nguyên model của nó; công tắc chỉ chặn lần dựng/đổi kế tiếp.

### Nhiều model cho một việc, tắt model hết tiền, nạp lại trước khi dựng

- **Job seating.** `create_agent` kèm `labels["team.job"]="<id>"` → cổng chấp nhận
  provider/model/thinking của **một executor đang bật của job đó** thay vì route duy
  nhất của lớp. Nhãn `team.model-class` vẫn bắt buộc và vẫn quyết định luồng (Peer
  không mượn lớp governance). Mã: `ROUTE_JOB_UNKNOWN`, `ROUTE_JOB_INACTIVE`,
  `ROUTE_JOB_EXECUTOR_MISMATCH` (kèm danh sách executor dùng được), `ROUTE_JOB_UNAVAILABLE`
  (file jobs hỏng — chỉ chặn seating có nhãn job), `ROUTE_JOB_IMMUTABLE`,
  `ROUTE_JOB_SEAT_FIXED` (update_agent đổi model của ghế job). `team_fork` chưa nhận job.
  Executor kiểu route phải có `thinking` mới dựng được; executor `cli` không phải ghế.
- **Tắt model.** `pteam routing disable-model|enable-model <họ>/<model>` — `disabledModels` trong
  file route mà cổng đọc (theo từng host trong file cluster). Lớp route trên model đó:
  `ROUTE_MODEL_DISABLED`; executor job trên model đó bị bỏ qua. Không đổi sang model khác.
  `*` ở cuối khoá: `pi/Minnyat/*` (cả endpoint), `pi/*` (cả công cụ).
- **Nạp lại.** `pteam jobs resolve <id>` in đúng tham số `create_agent` cho từng executor
  dùng được ngay lúc này. Lead/Supervisor nhận khối "Routing now" (Pi: mỗi lượt; Claude: lúc
  bắt đầu phiên và mỗi khi file đổi), và mọi lời từ chối của cổng kèm danh sách còn dùng được.
- **Không phủ:** ghế đang chạy giữ model cũ (sẽ lỗi — dựng ghế thay thế); Lead do Human tự
  khởi động và `defaultModel` của Pi; tắt công cụ CLI chỉ ẩn khỏi job; `remote-paseo.mjs run`.

### Cái gì có hiệu lực ngay, cái gì không

| Thay đổi | Khi nào có hiệu lực |
|---|---|
| Route (`model-routing` / `cluster-routing`), công tắc `enabled` và `disabledModels` | **Ngay.** Adapter Pi chạy `gate-routes` mỗi lần `create_agent`, hook Claude là một tiến trình mới mỗi lời gọi; không có cache. |
| Job, executor, `disabledTools` trong `jobs.local.json` | **Ngay.** `pteam jobs list/show` đọc file mỗi lần. |
| `~/.paseo/config.json` (provider Paseo) | Cần `paseo daemon restart`. |
| `~/.pi/agent/models.json` | Cần "Nạp lại cho Paseo" — tự động sau mỗi lần lưu section `pi-models` (CLI/WebUI, `config write pi-models [--no-refresh]`) và cuối `models sync`; sửa tay file thì chạy `pteam models refresh` hoặc nút "Nạp lại cho Paseo" trong WebUI. |
| Pi `settings.json` (tools mặc định, retry…), MCP | Từ phiên agent kế tiếp. |

Một lớp việc có thể có **nhiều tool + model** (`alternates`, xem mục dưới); một *việc*
dùng nhiều model/công cụ cùng lúc thì dùng **job** (README → "Job presets"). Không có
danh sách "thử cái kế khi cái trước hỏng": đó là silent fallback — Lead tự chọn.

### Một lớp, nhiều tool + model (`alternates`)

```json
"CODING_MEDIUM": {
  "paseoProvider": "pi-peer", "model": "Minnyat/gpt-5.6-terra", "thinking": "medium",
  "alternates": [
    { "paseoProvider": "claude-peer", "model": "claude-sonnet-5-5", "thinking": "medium" },
    { "paseoProvider": "pi-peer", "model": "Minnyat/deepseek-v4.1", "thinking": "high", "enabled": false }
  ]
}
```

- Các trường ở cấp route là lựa chọn **0** (chính); `alternates` là các lựa chọn khác của
  **cùng một lớp** — cùng **vai trò** (Peer vẫn là Peer), khác tool (pi/claude) hoặc khác
  model, mỗi cái có `enabled` riêng. Trùng hệt một lựa chọn đã có bị từ chối. File cũ (không
  có `alternates`) giữ nguyên nghĩa.
- **Lead chọn MỘT lựa chọn đang bật** cho mỗi agent và ghi đúng provider/model/thinking của
  nó; cổng chỉ kiểm lựa chọn đó có nằm trong danh sách đang bật (cùng họ + vai trò với ghế).
  Không có gì tự chọn thay Lead: `team_fork` không nêu model mà có ≥2 lựa chọn dùng được →
  `ROUTE_OPTION_AMBIGUOUS`; `update_agent` chỉ được chuyển sang lựa chọn khác của lớp.
- **Công tắc:** `pteam routing disable|enable <CLASS>` đổi cả lớp (mọi lựa chọn);
  `--option N` đổi một lựa chọn (0 = chính). `disable-model` tắt mọi lựa chọn dùng model đó.
  Lớp chỉ bị từ chối (`ROUTE_CLASS_DISABLED` / `ROUTE_MODEL_DISABLED`) khi **không còn lựa
  chọn nào** dùng được; còn lựa chọn thì lời từ chối của lựa chọn kia liệt kê những cái còn lại.
- **Sửa:** `pteam routing add-option <CLASS> --provider … --model … --thinking …` (kiểm tra
  với daemon thật như `set`), `remove-option <CLASS> <N>`; `set` đổi lựa chọn chính và **giữ**
  các lựa chọn khác. `routing show` liệt kê từng lựa chọn (`#N`), `routing check` / preflight
  kiểm từng cái (`route:CLASS#N`).
- Job: một executor kiểu `class` cho **mọi** lựa chọn đang bật của lớp đó là các ghế khả dĩ
  (`pteam jobs resolve` ghi `pickOne` — chọn MỘT).

## Chu trình bắt buộc của Lead (13 bước)

Xem `skills/paseo-team-lead/SKILL.md` → "Implementation — model routing
cycle". Tóm tắt: `MODEL_CLASS` → route local → `list_providers` →
`list_models` → exact string → `create_agent(provider=..., settings=
{thinkingOptionId})` → `get_agent_status` → bounded poll đến khi `runtimeInfo` xuất hiện → so khớp
`runtimeInfo`. Identity chưa populate trong timeout là
`BLOCKED: STARTUP_IDENTITY_UNAVAILABLE` và không archive; chỉ identity đã xuất
hiện nhưng lệch mới là `BLOCKED: MODEL_RESOLUTION_MISMATCH` và archive agent sai.

## Transmission format (đã xác minh bằng source Paseo 0.2.5)

```text
create_agent.provider = "<role-profile>/<pi-provider>/<model-id>"
```

Paseo tách ở **dấu `/` đầu tiên** (`resolveRequiredProviderModel`,
`server/agent/mcp-shared.js`):

```text
"pi-peer/Minnyat/deepseek-v4-flash"      → provider=pi-peer, model=Minnyat/deepseek-v4-flash
"pi-peer/openrouter/vendor/model-name"   → provider=pi-peer, model=openrouter/vendor/model-name
```

Thinking truyền riêng qua `settings.thinkingOptionId`
(pi levels: `off|minimal|low|medium|high|xhigh|max`).

## Bootstrap command đã verify live

```bash
# Human/Supervisor/Lead/Peer chạy trực tiếp, local daemon:
paseo run -d --provider "pi-peer/Minnyat/deepseek-v4-flash" --thinking low \
  --title "routing-smoke" "Reply with exactly: PONG"
# → inspect cho kết quả khớp:
paseo inspect <agent-id> --json
#   Provider=pi-peer | Model=Minnyat/deepseek-v4-flash | Thinking=low

# Đối chứng âm tính (model không tồn tại → error, KHÔNG silent fallback):
paseo run -d --provider "pi-peer/Minnyat/no-such-model" --thinking low "..."
paseo inspect <agent-id> --json   # → Status: error, Model vẫn hiển thị giá trị sai

# Direct pi CLI smoke test (kiểm pi inventory độc lập với Paseo):
pi --provider Minnyat --model deepseek-v4-flash --thinking low -p "Reply with exactly: PONG"

# Remote daemon (bootstrap remote — endpoint từ env, không ghi vào file):
paseo run --host "$PASEO_HOST_B" --provider "pi-peer/<pi-provider>/<model-id>" \
  --thinking high -d "<prompt>"
```

Supervisor/Lead bootstrap với exact model dùng đúng chuỗi trên với profile
`pi-supervisor` / `pi-lead` và `MODEL_CLASS` tương ứng
(`MONITOR_ECONOMY` cho supervisor normal observation, `REASONING_HIGH` cho
Lead orchestration — Workspace Protocol có thể nới xuống cho task routing
nhỏ). Lead model và Peer model không cần giống nhau; writer và reviewer ưu
tiên session + model resolution độc lập.

## Resolver + preflight

```bash
node scripts/model-routing.mjs validate                 # schema của route local
node scripts/model-routing.mjs gate-routes              # route table mà cổng create_agent đọc (JSON)
node scripts/model-routing.mjs resolve --class CODING_MEDIUM --json
node scripts/preflight.mjs [--json] [--skip-models]     # full host check
```

Mã lỗi fail-closed (không bao giờ fallback):

```text
CONFIG_INVALID                 route file lỗi schema/đọc được nhưng sai
ROLE_PROVIDER_UNAVAILABLE      role profile thiếu/vô hiệu trên daemon
MODEL_UNAVAILABLE              exact model không có trong list_models
THINKING_OPTION_UNAVAILABLE    thinking level model không offer, HOẶC model
                               tự khai không hỗ trợ extended thinking mà route
                               lại xin một level khác "off"
STARTUP_IDENTITY_UNAVAILABLE   runtimeInfo chưa xuất hiện trong startup timeout
MODEL_RESOLUTION_MISMATCH      observed runtime identity ≠ requested
HOST_ROUTE_UNAVAILABLE         class không có route trên host này
ROUTE_DISABLED                 route của class đang bị tắt (resolveRoute; preflight chỉ WARN)
```

Mã từ chối của cổng `create_agent` (tiền tố `BLOCKED:`):

```text
ROUTE_CLASS_MISSING            thiếu labels["team.model-class"]
ROUTE_CLASS_UNKNOWN            tên lớp không tồn tại
ROUTE_CLASS_WRONG_FLOW         lớp không thuộc vai trò ghế (vd. Lead dựng Supervisor bằng lớp của Peer)
ROUTE_CLASS_IMMUTABLE          update_agent định đổi nhãn team.model-class của một ghế
ROUTE_TARGET_UNREADABLE        không đọc được state của agent mà update_agent nhắm tới
ROUTE_CLASS_UNCONFIGURED       lớp (thường là lớp tuỳ chọn) chưa có route trên host
ROUTE_CLASS_DISABLED           route của lớp đang bị tắt (enabled: false) — `pteam routing enable`
ROUTE_TABLE_UNAVAILABLE        route file thiếu / sai / mơ hồ — fail-closed
ROUTE_UNVERIFIABLE             không nạp được route table
ROUTE_PROVIDER_UNKNOWN         provider không phải role provider
ROUTE_PROVIDER_NONCANONICAL    provider viết hoa / có khoảng trắng
ROUTE_PROVIDER_MISMATCH        family+role khác route
ROUTE_MODEL_MISMATCH           model khác route
ROUTE_THINKING_MISMATCH        thinking khác route
```

## Ba trạng thái của extended thinking

`list_models` có thể nói ba điều khác nhau về thinking, và resolver phân biệt
đủ ba — gộp trạng thái 2 vào trạng thái 3 chính là lỗi đã loại hẳn model rẻ
nhất (`claude-peer/claude-haiku-4-5`) khỏi mọi route strict:

| Daemon trả về | `thinkingValidated` | Kết quả |
|---|---|---|
| Có option list, chứa level yêu cầu | `exact` | pass |
| Có option list, KHÔNG chứa level | — | `THINKING_OPTION_UNAVAILABLE` |
| `thinkingSupported: false`, hoặc option list RỖNG (có mặt nhưng trống — đúng cách Haiku 4.5 tự khai) | `unsupported` | pass **chỉ khi** `thinking: off`; level khác → `THINKING_OPTION_UNAVAILABLE` |
| Không nói gì cả, route xin `thinking: off` | `off` | pass (kể cả `--strict`: không có gì để xác minh) |
| Không nói gì cả, route xin level khác | `unverifiable` | warn; `--strict` → FAIL |

Hai dòng cuối là ranh giới thật sự: **"không biết"** vẫn fail-closed như cũ,
còn **"biết chắc là không có"** là một sự kiện đã xác minh, không phải một
khoảng trống. Daemon nên công bố `thinkingSupported: false` một cách tường
minh; resolver chấp nhận cả option list rỗng như cùng một tuyên bố viết dưới
dạng dữ liệu.

## Provider `available` ≠ có model dùng được

`list_providers` báo `available` là nói về PROVIDER, không nói gì về inventory.
Đã quan sát thấy `pi-peer` báo `available` nhưng `list_models` trả về mảng rỗng
— provider trông như tồn tại, phía sau không có gì route được. Luôn gọi
`list_models` trước khi định tuyến; `node scripts/preflight.mjs` nay tự làm
việc này cho mọi role provider khỏe mạnh và cảnh báo (FAIL với `--strict`) khi
inventory rỗng.

## Ranh giới secret

- Không commit: `model-routing.local.json`, `cluster-routing.local.json`,
  `~/.pi/agent/{auth.json,models.json}`, `~/.paseo/config.json`, pairing URL,
  mọi endpoint có credential.
- `cluster-routing.local.json` chỉ tham chiếu endpoint qua **tên env var**
  (`connection.endpointEnv`); giá trị tcp://...?password=... nằm trong
  environment.
- Preflight chỉ báo env var có tồn tại hay không, không in giá trị.

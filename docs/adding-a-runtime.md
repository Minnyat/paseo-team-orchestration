# Thêm một coding agent (runtime) vào pack

Pack chạy cùng một bộ vai trò trên nhiều coding agent. Mỗi agent là một
**runtime family**, mô tả MỘT lần trong `RUNTIME_DESCRIPTORS`
(`scripts/model-routing.mjs`) cùng bản mirror trong
`extensions/paseo-team-core/policy-core.ts`. Hai bảng này được test khoá với
nhau. Routing, alternates, jobs, gate `create_agent`, `remote-paseo.mjs`,
preflight, WebUI và `pteam runtimes` đều đọc bảng này, nên không phải đi tìm
các nhánh `family === "..."` rải rác trong code.

## Bất biến: một runtime chỉ vào pack khi có cơ chế thực thi policy

| `enforcement` | Ý nghĩa | Vai được mang | Ví dụ |
|---|---|---|---|
| `full` | Adapter trong tiến trình quyết định lại từng tool call theo brief của turn hiện tại | supervisor, lead, peer | `pi` (extension), `claude` (hooks) |
| `static` | Permission config **của chính runtime**, sinh một lần cho mỗi role provider: deny cố định, không theo brief | **chỉ peer** | `opencode` |

Không có tier thứ ba. Coding agent không có hệ permission riêng (ví dụ `agy`,
chỉ chạy với `--dangerously-skip-permissions`) **không** trở thành seat. Nó
vào pack dưới dạng job `kind: "cli"` (`cliTools` trong `jobs.local.json`):
một Peer pi/Claude có policy chạy nó từ bash, nên policy của Peer đó vẫn soi
dòng lệnh.

Hệ quả của `static`, vì gate phải trung thực:

- Seat opencode **được sửa file** nhưng **không bao giờ** được `git commit`,
  `push`, `merge`, `rebase`, `reset --hard`, `paseo`, `pteam`, `webfetch`,
  `question`. Rule nằm ở `STATIC_PEER_BASH_DENY` trong
  `scripts/runtime-providers.mjs`. Đây là heuristic theo pattern, giống mọi
  luật bash khác của pack.
- Lead giao một brief có `COMMIT_AUTHORITY: allowed` hoặc
  `PUSH_TASK_BRANCH_AUTHORITY: allowed` cho seat `static` thì bị chặn ngay ở
  `create_agent` với mã `BLOCKED: RUNTIME_AUTHORITY_UNSUPPORTED`. Nếu không
  chặn, Lead sẽ chờ một SHA không bao giờ xuất hiện. Cách làm đúng: để
  opencode sửa file, rồi một Peer pi/Claude commit sau review, hoặc route task
  sang pi/Claude.
- `opencode-lead` và `opencode-supervisor` không tồn tại. `parseRoleProvider`
  trả `null`, nên mọi gate từ chối với `ROUTE_PROVIDER_UNKNOWN`.

## Dùng OpenCode theo từng nhiệm vụ

```bash
npm i -g opencode-ai                    # CLI trên host sẽ chạy seat
pteam runtimes                          # bảng: CLI có chưa, tier, vai, provider đã đăng ký chưa
pteam runtimes apply --dry-run          # xem provider opencode-peer sẽ được ghi
pteam runtimes apply                    # ghi vào ~/.paseo/config.json (ledger riêng, không đè provider viết tay)
paseo daemon restart
paseo provider models opencode-peer --json   # model id dạng "<provider>/<model>", thinking: default|none|minimal|low|...|max
```

Có ba cách gắn OpenCode vào **một nhiệm vụ**, cả ba đều được gate kiểm:

```bash
# 1) cả một class
pteam routing set FAST_READ --provider opencode-peer --model opencode/<model> --thinking low
# 2) thêm một lựa chọn cho class (Lead chọn đích danh khi seat)
pteam routing add-option CODING_MEDIUM --provider opencode-peer --model github-copilot/<model> --thinking high
# 3) một job preset: { "kind": "route", "paseoProvider": "opencode-peer", "model": "...", "thinking": "high" }
```

Từ máy khác: `remote-paseo.mjs run --host-id <id> --provider opencode-peer/<provider>/<model> ...`.
Host đích phải chạy `pteam runtimes apply` trước. Preflight trên host đó báo
`runtime:opencode` (FAIL nếu route trỏ tới provider chưa đăng ký, cảnh báo nếu
thiếu CLI, và luôn nhắc rằng policy là static).

## Các bước thêm một runtime mới (ví dụ codex, copilot)

1. Xác nhận Paseo cho `extends` provider gốc. Danh sách đo được trên Paseo
   0.14 nằm ở `PASEO_EXTENDABLE_BASES`: `claude, codex, copilot, opencode, pi,
   omp, acp`. Provider plugin như `antigravity` bị daemon từ chối với lỗi
   "extends unknown provider".
2. Thêm entry vào `RUNTIME_DESCRIPTORS` (model-routing.mjs): `label`, `cli`,
   `paseoBase`, `enforcement: "static"`, `roles: ["peer"]`, `thinkingLevels`
   **đo thật** bằng `paseo provider models <base> --json`, `hasPermissionModes`
   và `model` (`carriesProvider`, `hint`, `example`, `minRouteSegments`).
3. Mirror entry đó vào `RUNTIME_DESCRIPTORS` của policy-core.ts và thêm tên
   vào `RuntimeFamily`.
4. Thêm builder vào `STATIC_POLICY_BUILDERS` (runtime-providers.mjs). Builder
   dịch `STATIC_PEER_BASH_DENY` cùng các deny khác sang cú pháp permission của
   runtime đó, và nạp role prompt nếu runtime hỗ trợ. Thiếu builder thì
   `runtimeProviderEntry` ném lỗi: fail closed, không bao giờ sinh seat chỉ có
   prompt.
5. Chạy `npm test`. `test/runtime-families.test.mts` và
   `test/model-routing.test.mjs` khoá các điều sau: hai bảng khớp nhau;
   runtime không phải `full` thì chỉ mang peer; `paseoBase` được Paseo chấp
   nhận; có builder. Viết thêm test cho permission config của runtime mới
   theo đúng ngữ nghĩa đánh giá của nó (OpenCode: rule khớp **cuối cùng**
   thắng).
6. Kiểm tay với CLI thật. Với OpenCode:
   `OPENCODE_CONFIG_CONTENT=… opencode debug agent build` in ra ruleset đã
   resolve.

## Đã kiểm chứng thật (2026-11, Paseo 0.14.0, opencode 1.19.5)

- Daemon thật nhận provider `opencode-peer` do `pteam runtimes apply` sinh, và
  `paseo provider models opencode-peer` liệt kê 200 model với đúng shape
  `<provider>/<model>`.
- `opencode debug agent build` cho thấy các deny nằm sau `bash * allow`. Với
  ngữ nghĩa last-match, `git push…`, `git commit…` và `paseo…` ra `deny`;
  `npm test` ra `allow`; `question` và `webfetch` ra `deny`.
- Paseo giữ nguyên `OPENCODE_CONFIG_CONTENT` của provider và chỉ chèn thêm
  bridge plugin của nó (`opencode/bridge.js`, `decorateServerEnv`).
- **Chưa** chạy được một turn model thật: free tier của OpenCode báo "Free
  usage exceeded" qua IP proxy của môi trường test. Nên chạy lại bước đó trên
  máy có tài khoản model.

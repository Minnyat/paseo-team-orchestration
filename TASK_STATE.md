# Task: Pi session không nhận model config mới + routing check chậm

## Original request (verbatim)
"đang còn vấn đề nữa là khi cập nhật lại config của model thì tạo session mới với pi thì nó không nhận ngay giúp tôi kiểm tra fix lỗi và update lỗi này và cả router check vừa sửa đi"

## Success criteria
- [ ] Reproduce được: cập nhật model config (`~/.pi/agent/models.json`) → tạo session pi mới không nhận ngay; xác định root cause
- [ ] Fix: session mới nhận đúng model config mới (hoặc lỗi ở bước refresh được sửa + có bằng chứng live)
- [ ] `pteam routing check` nhanh lên: memoize inventory theo provider + song song hoá, không đổi ngữ nghĩa kiểm tra
- [ ] Test mới cho cả hai fix + toàn bộ test suite pass

## Constraints & decisions
- Không đổi ngữ nghĩa strict-resolve của routing check (fail-closed giữ nguyên)
- Theo docs: `~/.pi/agent/models.json` cần `pteam models refresh` để daemon nạp lại — điều tra xem refresh chỗ nào gãy

## Plan
- [x] Step 1: Điều tra `pteam models refresh` + cách daemon/adapter nạp models.json
- [x] Step 2: Reproduce bug session mới không nhận config mới
- [x] Step 3: Root cause + fix + test (auto-refresh trong `config write pi-models`, `--no-refresh` để tắt)
- [x] Step 4: Fix routingCheck (memoize + parallel) + test (1 ls + 1 models/provider; 38s → 2.9s thực tế)
- [x] Step 5: Chạy full test suite + self-review adversarial

## Log
- Fix 1: `cmdConfigWrite` async, `--no-refresh`; chỉ section pi-models refresh (refreshProviderSnapshot([])); fail không un-write, báo hint restart. WebUI `POST /api/config` đi qua CLI này → tự có. Fake client vào `env` block test để hermetic.
- Fix 2: `routingCheck` pre-warm inventory theo distinct provider song song + `liveInventory` memo promise `provider ls`; vòng lặp dùng map, thứ tự/check giữ nguyên; option tắt không fetch.
- Live verify: config write pi-models → daemon thấy model mới ngay (12, có minnyat/watch-probe); routing check 38s → 2.9s; dọn probe xong, daemon về 11 sạch.
- npm run check: 360/360 pass + typecheck sạch. Docs cập nhật (README + model-routing.md bảng hiệu lực).

## Debug: pi session không nhận model config mới
- Hypotheses: H1 refreshProvidersSnapshot no-op với provider lạ / H2 lệch target cwd / H3 adapter cache / H4 daemon catalog cache chưa bị reset
- Repro: thêm `cache-probe-test` vào models.json (LƯU Ý: models là ARRAY — lần 1 gán property lên array bị JSON.stringify vứt bỏ, repro giả) → daemon vẫn trả 11/12 model cũ
- Findings:
  - H4 đúng: daemon cache catalog theo tiến trình; sau `pteam models refresh` (8s, spawn `pi --mode rpc` thật) daemon thấy model mới → refresh HOẠT ĐỘNG trên Paseo 0.10.3
  - H1/H2/H3 loại: pi-peer có trong definitions, fetchCatalog chạy thật, không có adapter cache
  - GAP: WebUI không nút nào gọi `/api/models/refresh`; `POST /api/config` (section=pi-models) không refresh; chỉ `models sync` refresh cuối luồng
  - pi CLI đọc models.json tươi mỗi lần chạy (đã verify bằng --model mới)
- Root cause: mọi path cập nhật model config từ UI đều không reset cache daemon

## Open questions / risks
- Bug có thể nằm ngoài repo (pi core / Paseo daemon / pi-mcp-adapter) — nếu vậy, fix trong khả năng repo (vd: adapter reload) hoặc báo rõ ranh giới

## Log
- Bắt đầu: đã đọc routingCheck code (cli/lib/routing.mjs:544+), 18 option enabled × 2 spawn tuần tự ≈ 38s

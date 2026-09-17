# Premium với thanh toán thủ công

## Phạm vi đợt này

- Giữ giá, thời gian dùng thử, quyền Free và cách admin đối chiếu tiền MSB/PayPay. Không thay luồng Stripe.
- Modal giải thích lợi ích theo ngữ cảnh từ vựng, nghe, đề thi, sách; hiển thị so sánh Free/Premium trước bước thanh toán.
- Hạn mức nghe và đề thi lấy từ cùng policy backend dùng để thực thi. Không quảng cáo tính năng cá nhân hóa hoặc AI chưa được cấp quyền.
- Thanh toán không tự gia hạn. Nhấn “Tôi đã thanh toán” chỉ báo đã chuyển tiền, không cấp Premium.
- Sau khi user báo thanh toán, modal kiểm tra giao dịch mỗi 5 giây khi đang mở và tab hiển thị. Khi được duyệt, cập nhật tài khoản cục bộ và hiển thị “Tiếp tục học”; nút này tải lại đúng URL hiện tại để lấy nội dung mới.
- Duyệt trùng một giao dịch không cộng thêm hạn. Khóa cả hàng tài khoản để hai giao dịch được duyệt đồng thời vẫn cộng đủ ngày. Giữ nguyên hạn trọn đời khi mua thêm tháng/năm.

## API

### Rà soát giá, thông báo và giao diện

- Bảng giá và tạo yêu cầu dùng chung hàm phân giải giá từ cấu hình. Frontend gửi thêm `expectedAmount` và `expectedCurrency`; backend trả 409 nếu giá đã thay đổi, trước khi ghi yêu cầu. Hai trường là tùy chọn để tương thích client cũ.
- Không tự mở lại yêu cầu cũ. Người dùng chọn xem yêu cầu trước đó với đúng số tiền lịch sử. Yêu cầu PENDING khác giá hiện tại bị ẩn QR; có thể tạo mã mới hoặc báo đã chuyển theo yêu cầu cũ. Không sửa số tiền giao dịch đã tồn tại.
- `POST /manual-payments/requests/:id/mark-paid` cập nhật trạng thái và tạo thông báo admin trong cùng transaction, khóa hàng yêu cầu; gửi lại không tạo chuông trùng. Thông báo dẫn tới `/admin/manual-payments?openRequestId=...`.
- Admin mặc định chỉ hiển thị PAID_REPORTED (chờ duyệt). Tạo QR/yêu cầu PayPay chỉ là PENDING, không phát thông báo duyệt. Bản nháp bị loại khỏi toàn bộ danh sách, kể cả bộ lọc “Tất cả”; bỏ bộ lọc/chỉ số chờ user thanh toán. Chỉ tra cứu trực tiếp `requestId` để mở cuộc trao đổi hỗ trợ trước thanh toán vẫn được phép. API duyệt PENDING trả 409; chỉ PAID_REPORTED được cấp Premium, còn APPROVED giữ tính idempotent.
- Danh sách và chuông tự làm mới mỗi 15 giây khi tab hiển thị, làm mới khi focus. API admin hỗ trợ `requestId` để mở đúng yêu cầu kể cả nằm ngoài danh sách mặc định. `GET /admin/manual-payments` không truyền status mặc định lọc PAID_REPORTED; truyền `status=` để xem tất cả yêu cầu đã báo thanh toán/đã xử lý, không gồm PENDING. Frontend cũng lọc bản nháp nếu backend cũ còn trả về.
- Modal chỉ poll trạng thái sau khi user báo thanh toán, không poll khi mới tạo QR. Điều này tránh trình bày lỗi theo dõi duyệt ở bước chưa gửi duyệt.
- Duyệt hoặc từ chối ghi thông báo cho chủ yêu cầu trong cùng transaction đổi trạng thái; thao tác lặp không tạo thông báo trùng. Chuông user tự làm mới mỗi 15 giây và hiện dialog một lần cho thông báo chưa đọc. Khi duyệt, nút trong dialog lấy lại `/auth/me`, xác nhận quyền Premium rồi tải lại trang hiện tại; khi từ chối, dialog hiển thị ghi chú của admin nếu có.
- API thanh toán và mailbox đọc/ghi cùng backend được cấu hình; không fallback sang môi trường khác khi lỗi mạng. Biến môi trường frontend dùng cú pháp `import.meta.env` để Vite xử lý đúng.
- Mailbox yêu cầu JWT và lấy chủ sở hữu từ token; không tin `userId` trong query/body. Các response thanh toán không cache.
- Modal mới dùng tông xanh ngọc, thẻ chọn gói dạng radio, một khu vực số tiền/mã chuyển khoản, màn hình chờ duyệt riêng. Bố cục thích ứng desktop/mobile; hỗ trợ bàn phím và giữ focus trong dialog.
- Backend có 15 kiểm thử unit/integration, gồm giá bảng gói/yêu cầu/QR đồng nhất, phát hiện giá thay đổi, báo thanh toán đồng thời, chuông admin, quyền đọc mailbox và chặn duyệt trước khi user báo thanh toán. Browser suite kiểm tra báo giá cũ 999k so với 99k, hàng chờ trước/sau báo thanh toán, admin, duyệt, PayPay, lỗi giá và lỗi kết nối.
- Phiên frontend lưu nguyên cặp tài khoản/token trong `sessionStorage` theo tab. `localStorage` chỉ giữ tài khoản mặc định cho tab mới; đăng nhập/đăng xuất/giả lập tài khoản ở một tab không đổi danh tính tab khác. Tải lại tab giữ phiên của tab đó. Dữ liệu đăng nhập cũ được chụp một lần khi app mở; nếu tab đã bị ghi đè tài khoản trước bản sửa thì phải đăng nhập lại đúng tài khoản một lần.
- Menu, quyền truy cập Premium và route admin dùng subscription theo phiên tab để tránh menu hiện admin nhưng nội dung vẫn dùng snapshot user cũ. Kiểm thử Playwright mở hai trang trong cùng browser context (chung localStorage), kiểm tra token gửi API, reload, logout, quyền Premium cập nhật và impersonation.

`GET /manual-payments/settings` thêm `premiumPolicy` gồm `version`, `trialDays`, `freeExamLimitPerLevel`, `freeListeningLimitPerLevel`, `youtubeImportRequiresPremium`, `paymentMode`, `autoRenew`. Các trường cũ vẫn giữ.

`GET /manual-payments/requests/:id` yêu cầu bearer token. Chỉ chủ giao dịch đọc được; trả `{ request, access }`, trong đó `access` có `plan`, `role`, `premiumValidUntil`, `premiumTrialStartedAt`, `isPremium`. Không tìm thấy hoặc không sở hữu trả 404. Response không được cache.

`GET /manual-payments/requests/mine` giữ mặc định 20 yêu cầu mới nhất cho client cũ. Client có thể truyền `status=open` để chỉ lấy `PENDING` và `PAID_REPORTED`, `limit` (1–50, mặc định 20), `offset` (0–100000, mặc định 0). Response thêm `hasMore` để tải tiếp các yêu cầu cũ; thứ tự là `created_at DESC, id DESC`. Response không được cache và chỉ trả yêu cầu của tài khoản trong bearer token.

`GET /vocabulary/all` vẫn trả mảng, nhưng luôn phân trang: mặc định `limit=250`, tối đa 500; `offset` mặc định 0, số nguyên từ 0 đến 100000. Giá trị không hợp lệ trả 400. Kết thúc khi trang nhận được ít hơn `limit`. Ba màn hình học từ vựng trong frontend đã chuyển sang tải từng trang tuần tự. Trang chủ vẫn tải preview có `limit` riêng.

**Backend và frontend cần phát hành cùng đợt**: frontend cũ bỏ `limit` sẽ chỉ nhận trang đầu; frontend mới không tương thích với backend cũ bỏ qua `offset`. Kiểm tra cả hai phiên bản trước khi mở lại traffic trong lúc chuyển phiên bản.

## Bảo vệ dữ liệu

- IP lấy từ Express `req.ip`; không tự tin `X-Forwarded-For` hoặc `Host` do client gửi.
- Chỉ bỏ rate limit cho kết nối loopback khi `NODE_ENV=development`.
- Danh tính rate limit lấy từ JWT đã xác minh, không lấy từ `userId`/`X-User-Id` do client khai báo.
- Các alias `/api/...` và `/...` dùng chung ngân sách. Giới hạn tài khoản không phụ thuộc IP.
- Nhiều tài khoản dùng chung IP không còn là lý do tự động cấm IP. Các heuristic khác trong ApiShield vẫn là lớp bổ sung trong RAM từng instance.
- Rate limit cơ bản và ngân sách bản ghi từ vựng dùng PostgreSQL để chia sẻ giữa các instance trong production. Mất kho đếm trả 503 + Retry-After, không tự bỏ bảo vệ.
- Mỗi trang từ vựng tính theo số bản ghi yêu cầu, kể cả trang lặp hoặc trang cuối ngắn hơn; đây là reservation bảo thủ, không phải số nội dung khác nhau đã đọc. Áp dụng cả Free, trial và Premium.
- Đây là giảm khả năng quét hàng loạt, không phải bảo đảm chống sao chép tuyệt đối. Các tài sản công khai/bundle frontend và việc thu thập phân tán chậm vẫn cần đánh giá riêng.

## Triển khai

### Phát triển local

Frontend ở localhost vẫn có thể gọi Vercel nếu `VITE_API_MODE=2`. Phiên local ngày 11/09/2026 đã xác minh đúng trường hợp này: API trạng thái trên server trả HTML 404, trong khi API local trả JSON 200 cho các yêu cầu sẵn có của cùng tài khoản. Cấu hình local trong frontend `.env.development.local` (không commit) đặt `VITE_API_MODE=1`, `VITE_API_LOCAL_URL=http://localhost:4000`. File chỉ áp dụng mode development, không đổi cấu hình production. Đã kiểm chứng giá trị env trong module Vite đang phục vụ tại port 5173 và kiểm tra trình duyệt thật gọi API port 4000, chỉ đọc dữ liệu. Các yêu cầu trước đó trên Vercel không được di chuyển, sửa hay xóa.

1. Review và chạy migration `20260910120000_add_api_rate_bucket` trên đúng môi trường trước khi bật backend mới. Không có migration nào được áp dụng vào staging/production trong phiên phát triển này.
2. Chạy Prisma generate theo quy trình triển khai. Bảng `api_rate_bucket` bật RLS, không có policy cho client; DB role backend phải có quyền dùng bảng (owner/BYPASSRLS hoặc policy dành riêng cho backend).
3. Cấu hình `TRUST_PROXY_CIDRS` bằng IP/CIDR thật của proxy do bạn kiểm soát. Mặc định không tin proxy. Nếu không cấu hình đúng, nhiều người có thể bị tính chung theo IP proxy. Không đặt `true`, không đoán số hop, không tin header CDN nếu origin vẫn truy cập trực tiếp được.
4. `API_RATE_LIMIT_STORE=postgres` là mặc định khi `NODE_ENV=production`; `memory` dành cho local/test. DB hiện có được sử dụng, không cần dịch vụ Redis. Theo dõi độ trễ và tải DB do bộ đếm mới.
5. `CONTENT_ROWS_PER_HOUR` mặc định 15000 bản ghi yêu cầu/tài khoản hoặc khách/IP. Tổng theo IP bằng 3 lần mức này. Đây là ngưỡng vận hành ban đầu, cần điều chỉnh bằng traffic học thật, không phải hạn mức thương mại của Premium.
6. Bộ đếm có dọn tối đa 500 hàng hết hạn mỗi 500 lần ghi trong một instance. Với serverless sống ngắn, lên lịch backend/DB xóa hàng hết hạn định kỳ bằng truy vấn có giới hạn tương tự; không mở endpoint dọn dữ liệu công khai.
7. Xác nhận webhook Stripe không nằm trong checklist của lần phát hành thủ công này. Kiểm thử MSB/PayPay bằng tài khoản thử, kiểm tra đúng số tiền/thời hạn và thao tác admin duyệt trước khi thông báo thay đổi.

## Kiểm chứng

### Kết quả xác nhận trước commit — 11/09/2026

- [x] Backend `npm run build` thành công.
- [x] Frontend `npm run build` thành công.
- [x] 15/15 kiểm thử backend đạt trên PostgreSQL thử riêng; không dùng database thật để tạo/duyệt thanh toán thử.
- [x] ESLint các file frontend chỉnh sửa đạt.
- [x] Playwright desktop 1280px và mobile 390px đạt: báo giá cũ/mới, không poll bản nháp, ẩn bản nháp kể cả “Tất cả”, chuông sau báo thanh toán, duyệt, PayPay, trial và giữ focus.
- [x] Hai tab trong cùng browser context đạt: tách tài khoản/token, reload, logout, impersonation, cập nhật thẻ Premium và bỏ qua phản hồi tài khoản cũ.
- [x] Kiểm tra trực tiếp frontend đang chạy ở localhost:5173: API local trả JSON 200 cho yêu cầu sẵn có; danh sách admin “Tất cả” không trả PENDING. Chỉ đọc dữ liệu thật.
- [x] Cấu hình `.env.development.local` chuyển frontend development sang localhost:4000; file env và ảnh QA được loại khỏi commit.
- [ ] Migration và cấu hình proxy/rate limit trên production: là điều kiện phát hành, chưa chạy trong phiên này.

Build frontend còn cảnh báo có sẵn về Browserslist cũ, `eval` trong pdfjs-dist và bundle lớn; không làm build thất bại. Kiểm thử này không xác nhận giao dịch ngân hàng thật hoặc khả năng chống sao chép tuyệt đối.

- Backend: `npm run build`, `node --test tests/premium-security.test.cjs`.
- Integration: `tests/premium-postgres.test.cjs` yêu cầu PostgreSQL dùng riêng tại `127.0.0.1:55439/postgres`, schema đã tạo bằng Prisma db push, và biến `PREMIUM_TEST_DATABASE_URL`. Suite tạo dữ liệu tổng hợp và chỉ dọn schema `premium_migration_test` của chính nó. Không chạy trên DB local đang có dữ liệu làm việc.
- Frontend: `npm run build`, `node tests/premium-browser.mjs`. Suite dùng Vite port 5197 và Playwright, mock toàn bộ API và chặn kết nối dịch vụ ngoài. Ảnh QA nằm trong `.premium-qa/` và không commit.
- Đã kiểm tra thật concurrency PostgreSQL; giao dịch pending/approved/rejected, quyền sở hữu, duyệt trùng, gia hạn đồng thời, trọn đời; frontend desktop/mobile, keyboard focus, khôi phục pending và PayPay.

## Hướng phát triển Premium tiếp theo

Chưa đổi các con số Free theo cảm tính. Giai đoạn tiếp theo nên đo: hoàn thành buổi học đầu, quay lại ngày 7, tỷ lệ mở modal → chọn gói → báo chuyển tiền → được duyệt, thời gian chờ duyệt, gia hạn và phản ánh bị giới hạn nhầm. Đợt này chưa bổ sung hệ thống analytics.

Sau khi có baseline, thử từng thay đổi: bài mẫu nghe được tuyển chọn, gợi ý bài tiếp theo dựa trên lỗi sai, hoặc trial ngắn hơn cho nhóm người dùng mới. Lịch sử và tiến độ cơ bản vẫn giữ khi hết Premium. Chỉ đưa lợi ích lên bảng bán khi quyền truy cập và tính năng đã có thật.

Tài liệu kỹ thuật đối chiếu: https://expressjs.com/en/guide/behind-proxies/ và https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/.

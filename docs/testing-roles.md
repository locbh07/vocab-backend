# Hướng dẫn vai trò cho Claude Code

Dùng khi làm việc trên cặp repo **vocab-backend** (API) + **vocab-frontend** (giao diện). Trong dự án này, Claude sẽ đóng 3 vai trò khác nhau tùy theo từ khóa được gọi. Tuyệt đối tuân thủ nguyên tắc của từng vai trò.

> **Lưu ý stack thực tế** (bản nháp gốc ghi "Spring Boot/MyBatis" — không đúng với 2 repo này, đã sửa lại bên dưới):
> - **Backend** (`vocab-backend`): Node.js + **Express 4** + **TypeScript** + **Prisma** (PostgreSQL). Không dùng Java/Spring/MyBatis.
> - **Frontend** (`vocab-frontend`): **React 19** + Vite + React Router + Tailwind CSS. State cục bộ bằng `useState`/`useEffect`, không Redux.

---

## 1. Vai trò: Planner (Người lên kế hoạch)

- **Nhiệm vụ:** Phân tích yêu cầu, xác định luồng dữ liệu (data flow) giữa Frontend và Backend. **KHÔNG ĐƯỢC VIẾT CODE.**
- **Đầu ra:** Liệt kê từng bước cần làm, chỉ định đích danh file nào cần tạo mới, file nào cần sửa. Với dự án này, chỉ rõ theo đúng cấu trúc thật:
  - Cần thêm/sửa cột dữ liệu → chỉ rõ có cần migration Prisma không (`prisma/migrations/<timestamp>_<name>/migration.sql`) và có cần sửa `prisma/schema.prisma` không.
  - Cần thêm logic dùng chung nhiều nơi → chỉ rõ file trong `src/lib/` (vd. `src/lib/srs.ts`, `src/lib/xp.ts`, `src/lib/streak.ts`, `src/lib/badges.ts`).
  - Cần thêm endpoint → chỉ rõ file route trong `src/routes/` và method/path cụ thể (vd. `GET /learning/stats-summary` trong `src/routes/learning.ts`).
  - Cần gọi API ở giao diện → chỉ rõ file component trong `src/components/**/*.jsx` và endpoint sẽ gọi.
  - Đảm bảo kế hoạch có đề cập khía cạnh UX cơ bản (trạng thái đang tải, rỗng, lỗi) và khía cạnh bảo mật cơ bản (endpoint có cần xác thực người dùng không).

## 2. Vai trò: Developer (Lập trình viên)

- **Nhiệm vụ:** Chỉ viết code dựa trên bản kế hoạch đã được duyệt.

### Backend (Express + TypeScript + Prisma)

- Kiến trúc thực tế của repo này **không** phân lớp Controller/Service/Repository kiểu Spring. Quy ước hiện có:
  - `src/routes/*.ts` — định nghĩa route + gọi Prisma/raw SQL trực tiếp trong handler (đây là chuẩn hiện tại, không phải anti-pattern cần "sửa lại" trừ khi task yêu cầu refactor).
  - `src/lib/*.ts` — logic dùng chung cho **nhiều route** (vd. tính FSRS, tính streak, cộng XP) phải được tách ra đây thay vì copy-paste vào từng route.
  - `src/middleware/` — có sẵn `userGuard.ts` (`requireUser(req)`) và `adminGuard.ts` (`requireAdmin(req)`) để xác thực qua Bearer token. **Endpoint nào thao tác dữ liệu riêng tư của user thì nên gọi `requireUser`/`requireAdmin` thay vì chỉ tin vào `userId` truyền từ query/body** (xem cảnh báo bảo mật ở mục QA bên dưới).
- **Không migration bằng `prisma migrate dev` hay `prisma db push`** — `schema.prisma` chỉ phản ánh một phần DB thật, 2 lệnh này có thể xóa nhầm bảng không khai báo trong schema. Chỉ viết tay file `migration.sql` dạng idempotent (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`) rồi áp dụng bằng `npm run prisma -- migrate deploy`.
- Response format thực tế của repo: **JSON thuần, không bọc envelope `{success, data}`** — thành công trả thẳng object/array, lỗi trả `res.status(4xx/5xx).json({ message: "..." })`. Giữ đúng convention này khi thêm endpoint mới.
- Validate input tối thiểu theo pattern đã dùng khắp nơi: `Number.isFinite(userId)` → 400 nếu sai.

### Frontend (React)

- Gọi API qua `fetchWithFallback` (từ `@/utils/api`) — không dùng `fetch`/`axios` trực tiếp, vì hàm này đã xử lý sẵn base URL theo môi trường, header `Authorization`, và fallback khi local API lỗi.
- Lấy user hiện tại qua `getCurrentUser()` (từ `@/utils/auth`), không đọc thẳng `localStorage`.
- Text hiển thị luôn qua `t("key")` (từ `@/i18n/strings`), key mới thêm vào `src/i18n/locales/vi.json` (nguồn duy nhất, các ngôn ngữ khác dịch lại sau bằng script riêng).
- Trạng thái Loading/Error/Empty phải hiển thị rõ ràng, tái dùng đúng quy ước đang có trong app (xem mục QA bên dưới) thay vì tự nghĩ ra kiểu mới mỗi lần.

## 3. Vai trò: Tester & QA (Kiểm thử viên)

- **Nhiệm vụ:** Đóng vai người dùng thực tế (end-user) và chuyên gia review code. Rà soát từ logic hệ thống đến trải nghiệm giao diện.

### Kiểm tra Logic & Bảo mật (Backend)

- ⚠️ **Đã phát hiện lúc soạn tài liệu này:** hầu hết endpoint trong `src/routes/learning.ts` và `learningGame.ts` (bao gồm toàn bộ endpoint mới thêm ở các phase gần đây: `/review-result`, `/badges`, `/progress-summary`, `/stats-summary`, `/activity-leaderboard`...) nhận `userId` thẳng từ query/body **mà không gọi `requireUser`/`requireAdmin` để xác nhận đây đúng là user đang đăng nhập**. Về lý thuyết, ai cũng có thể đổi `?userId=` sang ID người khác để đọc/ghi dữ liệu học tập, XP, streak của họ. Đây là lỗ hổng có sẵn từ trước (không phải do các phase gần đây gây ra, nhưng các phase đó cũng xây tiếp trên cùng pattern này) — cần đánh giá mức độ ưu tiên sửa (thêm `requireUser` + đối chiếu `userId` trong token với `userId` trong query) riêng, không nằm trong phạm vi review UI/UX thông thường.
- Đánh giá khả năng bắt lỗi (exception handling): DB mất kết nối, dữ liệu null, sai định dạng số (`userId` không phải số) có trả về lỗi có kiểm soát (400/500 + message) thay vì crash server không?
- Dữ liệu nhạy cảm (passwordhash, token nội bộ, thông tin thanh toán) có vô tình lọt vào response JSON không? Endpoint admin (`/admin/*`) có bắt buộc `requireAdmin` không?

### Kiểm tra UI/UX (Frontend)

- **Trạng thái hệ thống:** Quy ước hiện tại của app là text loading dạng "Đang tải..." (không có spinner/skeleton dùng chung) — chấp nhận được, nhưng cần nhất quán. Nút bấm gọi API có `disabled={loading}`/`disabled={submitting}` để tránh double-submit không (đây là pattern đã dùng khá nhất quán, kiểm tra endpoint mới có theo không).
- **Phản hồi người dùng:** App **chưa có hệ thống toast/snackbar dùng chung** — thành công/thất bại hiện tại hiển thị bằng text màu inline (`text-emerald-700` cho thành công, `text-red-600`/`text-rose-700` cho lỗi) đặt ngay dưới action, trừ tính năng huy hiệu (`BadgeUnlockToast.jsx`) có toast riêng. Khi thêm tính năng mới, cân nhắc: theo đúng pattern text-inline cho nhất quán, hay đây là lúc nên làm 1 toast component dùng chung — nên hỏi trước khi tự quyết.
- **Nhập liệu:** Kiểm tra từng form cụ thể (vd. AuthPage) xem đã validate phía client chưa hay đợi API trả lỗi mới báo — chưa có quy ước chung, cần đánh giá theo từng trường hợp.
- **Tính nhất quán & Empty state:** Quy ước đang dùng: card bo góc rất lớn (`rounded-[24px]` đến `rounded-[50px]` tùy kích thước), số liệu nổi bật dùng `font-black` (không dùng `font-bold` cho số liệu chính), màu theo domain (xanh dương/cyan = từ vựng, xanh lá/emerald = kanji, cam/hổ phách = streak). Empty state luôn có câu thông báo riêng (vd. "Chưa có dữ liệu để hiển thị.") thay vì màn hình trắng — kiểm tra tính năng mới có tuân theo không.

### ⭐ Responsive / đa màn hình (ưu tiên cao — người yêu cầu review khó tính về trải nghiệm)

Test ở **tối thiểu 5 mốc kích thước**, không chỉ "thu nhỏ trình duyệt cho vừa mắt":

| Mốc | Kích thước tham khảo | Vì sao |
|---|---|---|
| Mobile nhỏ | 375×667 (iPhone SE) | Dễ lộ tràn ngang, chữ chồng nhau nhất |
| Mobile phổ biến | 390×844 (iPhone 12/13/14) | Kích thước thực tế đa số user dùng |
| Tablet dọc | 768×1024 | Đúng ngưỡng đổi layout của `Menubar` (menu hamburger ↔ bottom-tab) |
| Tablet ngang / laptop nhỏ | 1024×768 hoặc 1280×800 | Ngưỡng `xl:` — `Menubar` đổi sang dropdown desktop tại đây |
| Desktop rộng | 1600×900+ | `HomePage-2.jsx` dùng `max-w-[1600px]`, cần kiểm tra không bị dạt trống 2 bên hoặc vỡ bố cục khi màn hình lớn hơn |

Kiểm tra cụ thể ở mỗi mốc:
- **Không tràn ngang** (không có scrollbar ngang, `body` không rộng hơn viewport) — lỗi phổ biến nhất khi thêm bảng/chart/nội dung dài.
- Nút bấm và vùng chạm (tap target) trên mobile đủ lớn (khuyến nghị ≥ 40-44px), không bị dính sát nhau gây bấm nhầm.
- Text tiếng Việt có dấu, tên người dùng dài, số liệu lớn (hàng nghìn) không bị vỡ dòng xấu hoặc bị cắt (`overflow: hidden` cắt chữ là dấu hiệu lỗi, không phải cách "giải quyết" tràn chữ).
- Trang mới có breakpoint riêng thì phải **cố ý chọn** theo đúng 1 trong 3 vùng mà `Menubar` đã định nghĩa (mobile hamburger `<768px`, tablet bottom-tab `768–1279px`, desktop dropdown `≥1280px`) thay vì tự chế 1 mốc `sm:` khác biệt gây lệch cảm giác chuyển layout so với phần còn lại của app.
- **Giới hạn công cụ cần biết:** Playwright WebKit chạy trên Windows **không** render đúng `backface-visibility`/3D transform — không dùng nó để tự tin kết luận "flip card ổn trên iOS Safari". Với bất kỳ chỗ nào dùng 3D flip/transform (thẻ flashcard, v.v.), cần test bằng Chromium thật + báo rõ là "chưa verify trên Safari thật" thay vì khẳng định đã test đủ.
- Các bug đã từng xảy ra, ưu tiên test lại khi đụng vào vùng liên quan: thẻ flashcard bị cắt mất phần đọc hiragana khi câu ví dụ dài (do `overflow` + `justify-center`), layout dùng chuỗi `h-full`/`flex-1` lồng nhau gây đè chồng thẻ (nên đo chiều cao bằng `ref` thay vì chuỗi flex), chữ kanji phải căn giữa đúng tâm chấm đỏ trang trí trong `VocabularyCard`.

### ⭐ Độ phù hợp thiết kế (design fit)

- Tính năng mới có "hòa" vào app hay trông như bị gắn thêm không: đối chiếu bo góc, khoảng cách (padding/margin theo nhịp 4/tương tự Tailwind), shadow (công thức hay gặp `shadow-[0_24px_70px_-35px_rgba(15,23,42,0.35)]`), cỡ chữ/độ đậm với các trang liền kề đã có (HomePage, AccountPage).
- Icon dùng `lucide-react`, cỡ nhất quán trong cùng ngữ cảnh (không lẫn icon set khác, không lệch size so với icon cạnh bên).
- Với biểu đồ (`recharts`, trang `/learning-stats`): màu đã chạy qua công cụ kiểm tra an toàn màu sắc (`dataviz` skill) nhưng có 1 cảnh báo còn tồn: màu xanh lá (kanji, `#1baf7a`) có độ tương phản hơi thấp trên nền trắng — khi review thực tế cần xác nhận vẫn đọc được nhãn/tooltip rõ ràng, không chỉ dựa vào màu đường/cột để phân biệt vocab với kanji.
- Nếu thấy 1 màn hình "trông ổn nhưng hơi khác" so với phần còn lại — hỏi lại xem là chủ đích hay lệch chuẩn ngoài ý muốn, đừng tự sửa theo phán đoán cá nhân khi không chắc chuẩn hiện có là gì.

- **Đầu ra:** Chỉ ra lỗi cụ thể kèm đề xuất đoạn code cần sửa (bảo mật lẫn UX), không chỉ mô tả chung chung.

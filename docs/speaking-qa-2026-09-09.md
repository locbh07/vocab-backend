# Speaking studio — thiết kế và kiểm thử (2026-09-09)

## Phạm vi đã hoàn thành

- `/speaking`: giao diện sáng, hai lựa chọn AI/live, minh họa bằng CSS và icon, hướng dẫn bắt đầu.
- `/speaking/ai`: chọn giọng trực quan, tìm chủ đề không cần dấu, lọc JLPT, thông báo loading/error/empty và thử lại.
- `/speaking/ai/:sessionId`: phòng hội thoại đồng bộ giao diện, vùng nghe/nhận xét/micro, nút điều khiển có nhãn truy cập.
- `/speaking/live-teacher`: thiết lập giáo viên, kiểu buổi học, trình độ/chủ đề; phòng gọi và màn hình kết thúc đồng bộ.
- Giữ nguyên các URL và API contract. Giáo viên Live là giáo viên **AI thời gian thực**; giao diện giải thích rõ điều này. Quyền truy cập live vẫn được kiểm tra ở backend.

## Các lỗi đã sửa

- Khóa đồng bộ thao tác bắt đầu để double-click không tạo hai phiên AI/live.
- Thu âm AI được hủy và giải phóng micro khi chuyển sang gõ chữ, kết thúc phiên hoặc rời trang. Bản thu đã hủy không tự gửi lên STT; yêu cầu STT đang chạy được hủy.
- Chặn micro được cấp muộn sau khi người dùng rời trang; dừng track ngay khi lời gọi getUserMedia hoàn tất.
- Kết thúc phiên AI hiển thị lỗi và cho thử lại nếu API thất bại; ngăn ghi âm lại sau khi phiên đã kết thúc.
- Live xin quyền micro trước khi tạo token. Lỗi kết nối và mất kết nối giữa cuộc gọi đưa người dùng về trạng thái có thể thử lại, đồng thời dọn tài nguyên.
- Thanh tốc độ chỉ xuất hiện khi chọn OpenAI, là nhà cung cấp hỗ trợ tham số đó.
- Backend chỉ áp dụng lựa chọn Gemini model từ request body khi người dùng là admin; tài khoản thường nhận model mặc định. Đây là kiểm tra cấu hình ở endpoint, không thay đổi giao thức ephemeral token của nhà cung cấp.

## Kết quả kiểm thử

**Build/lint**

- `npm run build` ở cả frontend và backend: thành công.
- `npx eslint src/components/Speaking` ở frontend: không có lỗi/cảnh báo.
- Frontend build còn cảnh báo có sẵn về kích thước chunk, dữ liệu Browserslist cũ và `eval` trong pdfjs; không phải lỗi của speaking.

**27 kiểm tra UI tự động** — `vocab-frontend/scripts/test-speaking-ui.mjs`

Dùng Chromium, mock API và WebSocket để kiểm thử có thể lặp lại: tìm kiếm/lọc, lưu giọng, double-click, gửi chữ, sửa lỗi/gợi ý/dịch, từ chối micro, lỗi tải/tạo/kết thúc phiên, giải phóng micro, ngắt live và thử lại, quyền truy cập và điều hướng đăng nhập. Không phát hiện lỗi JavaScript trong trình duyệt.

Kiểm tra cả năm màn hình (hub, topics, chat, live setup, live call) ở 375×667, 390×844, 768×1024, 1024×768, 1600×1000. Không tràn ngang; các nút micro của phòng học nằm trong viewport.

**5 kiểm tra backend** — `vocab-backend/scripts/test-speaking-live.cjs`

Tài khoản thường không ghi đè model/provider qua body; admin chọn model hợp lệ được; model không hợp lệ về mặc định; tài khoản chưa được cấp live bị từ chối. Các test này mock lớp người dùng và nhà cung cấp, không truy cập database hoặc dịch vụ AI.

**15 kiểm tra với dịch vụ thật** — `vocab-frontend/scripts/test-speaking-local.mjs`

- Database dùng `.env.local`, được xác minh host local. Không dùng backend đang chạy ở cổng 4000 vì cấu hình hiện tại của tiến trình đó trỏ tới database ngoài máy.
- Backend test chạy riêng ở `127.0.0.1:4001`, không chạy entrypoint có tác vụ nhắc học.
- Kiểm tra xác thực 401 và quyền live 403 bằng endpoint thật/database local.
- Tải được 9 chủ đề tình huống và chủ đề trò chuyện tự do.
- Tạo phiên AI, nhận lời chào thật; gửi chữ và nhận câu trả lời kèm âm thanh; dịch và gợi ý thành công.
- Google TTS tạo đoạn tiếng Nhật để đưa vào micro giả lập của Chromium. MediaRecorder → Google STT nhận được nội dung tiếng Nhật → AI trả lời tiếp thành công.
- Gemini Live tạo kết nối thật, giáo viên chào, nhận một lượt micro và trả lời; kết thúc cuộc gọi thành công.
- Phiên AI local được tạo trong lần chạy thành công: **97**, đã kết thúc.
- Kho âm thanh R2 được thay bằng bộ nhớ trong tiến trình test, tránh ghi audio có ID local đè lên dữ liệu dùng chung. Google TTS/STT và mô hình AI là dịch vụ thật; upload/download R2 không nằm trong lần kiểm chứng này.

Ảnh và kết quả máy đọc được ở `vocab-frontend/.speaking-qa/` (đã gitignore), gồm `ui-results.json`, `real-results.json`, ảnh desktop/mobile và ảnh các lượt test thật.

## Chạy lại

Từ frontend, bật Vite bằng `npm run dev`, rồi:

```powershell
node scripts/test-speaking-ui.mjs
```

Từ backend:

```powershell
node --test scripts/test-speaking-live.cjs
npm run build
```

Test dịch vụ thật cần backend repo nằm cạnh frontend, `.env.local` có database local và tài khoản local đã được bật live, khóa AI/TTS hợp lệ, FFmpeg, cổng 4001 trống. Test tạo phiên trong database local và dùng dịch vụ AI có tính phí; bắt buộc bật rõ biến sau:

```powershell
$env:SPEAKING_REAL_TESTS = '1'
node scripts/test-speaking-local.mjs
Remove-Item Env:SPEAKING_REAL_TESTS
```

## Giới hạn đã biết của lần kiểm thử

Chưa xác minh trên Safari/iOS hoặc micro vật lý. Nhánh OpenAI realtime chỉ kiểm tra lựa chọn UI; cuộc gọi thật được kiểm tra bằng Gemini mặc định. Chưa đánh giá chất lượng sư phạm qua hội thoại dài hoặc tình huống mạng chập chờn thực tế.

Về đa ngôn ngữ: 69 chuỗi speaking mới đã được dịch sang `en.json` (2026-09-09), nên tiếng Anh không còn fallback. Bảy ngôn ngữ còn lại (zh, ko, pt, id, ne, my, fil) vẫn hiển thị tiếng Việt cho nhóm chuỗi này. Ngoài phạm vi speaking, `en.json` còn thiếu sẵn 89 khóa của các tính năng khác (vocabulary, learning, badges, home) — nợ cũ, không phát sinh từ đợt này.

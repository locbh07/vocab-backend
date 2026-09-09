# Luyện từng mondai

## Kiểm tra dữ liệu local — 2026-09-09

Đã đọc 330 bản ghi `jlpt_exam`, tương ứng 110 đề và 10.925 câu. Không sửa dữ liệu database.

| Level | Số đề | Từ vựng | Ngữ pháp | Đọc hiểu | Nghe |
| --- | ---: | --- | --- | --- | --- |
| N1 | 31 | Mondai 1–4 | 5–7 | 8–13 | Trọn phần 3 |
| N2 | 31 | Mondai 1–6 | 7–9 | 10–14 | Trọn phần 3 |
| N3 | 30 | Mondai 1–5 | 1–3 | 4–7 | Trọn phần 3 |
| N4 | 13 | Mondai 1–5 | 1–3 | 4–6 | Trọn phần 3 |
| N5 | 5 | Mondai 1–4 | 1–3 | 4–6 | Trọn phần 3 |

Cấu trúc nhìn chung đồng nhất theo level nhưng số câu thay đổi theo năm. Ví dụ N2 mondai 3 có 3–5 câu, mondai 4 có 5–7 câu; mondai 1 luôn có 5 câu trong 31 đề hiện tại. N1/N2 đang lưu ngữ pháp trong part 1, đọc hiểu trong part 2. N3–N5 bắt đầu lại số mondai trong part 2.

Ngoại lệ dữ liệu:

- N3 có 28/30 đề có mondai đọc 7 và 28/30 đề có câu nghe.
- N4 chỉ 9/13 đề có câu trong các mondai đọc 4–6. Mondai ngữ pháp 3 có 12/13 đề.
- N5 chỉ 3/5 đề có câu trong các mondai đọc 4–6; ngữ pháp 1–2 có 4/5 đề, ngữ pháp 3 có 3/5 đề.
- Có lỗi OCR `間題`, `問题`, dấu `:` sau `問題`, chữ số toàn chiều rộng và cách viết `もんだい`. Bộ phân nhóm nhận diện các biến thể này.
- Một số câu chưa có đáp án; luyện tập báo số câu chưa thể chấm và loại khỏi mẫu số. Các lựa chọn nghe trống vẫn hiện số lựa chọn gốc vì nội dung có thể nằm trong audio.

Bộ phân nhóm mới bao phủ đủ 10.925/10.925 câu trong snapshot local. Câu ở mục rỗng không được tạo thêm; tiêu đề không nhận diện được trong dữ liệu tương lai được bỏ qua thay vì đoán theo vị trí hoặc số câu.

## Kế hoạch và triển khai

1. Kiểm tra dữ liệu, nhận diện mondai theo tiêu đề thực tế.
2. Thêm catalog theo level, tái sử dụng quyền truy cập đề hiện có.
3. Thêm menu “Luyện từng phần” dưới menu level trên `/exam`, hỗ trợ desktop/mobile.
4. Mở `/exam/practice/:level`, chọn nhóm → luyện đề mới nhất → kiểm tra đáp án → cùng nhóm của đề tiếp theo, theo thứ tự đề giảm dần.
5. Giữ toàn bộ bài nghe, đoạn văn đọc và vị trí câu gốc cho các API giải thích. Lưu bài làm luyện tập riêng trên thiết bị, không gọi API nộp bài thi toàn bộ.
6. Chạy build, kiểm thử bộ phân nhóm/API và luồng giao diện với snapshot dữ liệu local.

Nhóm có ID theo loại bài và số mondai, ví dụ `vocabulary-1`, `grammar-1`, `reading-10`; nghe có ID `listening`. Level nằm trong URL. Cách này tránh trùng số ở N3–N5, đồng thời giữ được nhóm N1/N2 nếu dữ liệu đổi vị trí part. Mỗi đoạn của bài luyện vẫn giữ `part` và `sectionIndexes` của đề gốc.

## API

`GET /exam/practice/:level?userId=<id>&code=<optional>` (cũng có prefix `/api/exam`).

Trả về `{ level, fullAccess, groups }`. Mỗi group có `id`, `category`, `mondai`, `label`, `exams`. Mỗi exam có `examId`, `questionCount`, `segments: [{ part, sectionIndexes }]`. Danh sách không chứa nội dung hoặc đáp án câu hỏi.

Catalog chỉ chứa các đề người dùng được truy cập: premium/admin xem toàn bộ; tài khoản thường giới hạn theo `FREE_EXAM_LIMIT_PER_LEVEL`, giống danh sách đề hiện tại. Frontend tải nội dung qua `GET /exam/:level/:examId`, nơi quyền truy cập được kiểm tra lại. Level sai trả 400, không tìm thấy user trả 404. Không thay schema hoặc migration.

URL bài luyện hỗ trợ `?group=vocabulary-1&exam=202512`. Khi không có `exam`, dùng đề mới nhất của nhóm. Bài làm được lưu bằng key `jlpt_practice_<user>_<level>_<group>_<exam>`; không đồng bộ giữa thiết bị. Hoàn thành đề cuối thì thông báo kết thúc, không tự quay vòng.

## Kiểm thử

Backend: `npm run build` rồi `node --test scripts/test-exam-practice.cjs`.

Frontend: `npm run build`; lint các file mới. Kiểm thử trình duyệt dùng snapshot local và API giả lập để tránh ghi dữ liệu/khởi tạo giải thích AI: chọn mondai, trả lời, giữ draft sau refresh, chấm bài, next/reset, đọc hiểu, nghe trọn bài và bố cục mobile. Audio giữ URL hiện có; chưa xác minh chất lượng/nội dung của file âm thanh.

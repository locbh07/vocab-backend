# Gói dữ liệu làm việc với AI web

Gói này không chứa mật khẩu, API key, thông tin người dùng hay lịch sử làm bài. Dữ liệu được chia thành batch nhỏ để có thể tải từng file lên ChatGPT, Claude, Gemini hoặc AI web khác.

## Thứ tự nên làm

Ưu tiên `exam-explanations`, sau đó mới đến `vocabulary` và `grammar`.

1. Mở thư mục `exam-explanations/input` và chọn `batch-0001.json`.
2. Tải file đó lên AI web.
3. Tải thêm file `GOLDEN_SAMPLES.md`, rồi gửi nguyên prompt ở phần dưới.
4. Tải file JSON mà AI trả về, giữ đúng tên `batch-0001.json`, rồi đặt vào `exam-explanations/results`.
5. Làm lần lượt `batch-0002.json`, `batch-0003.json`... cho đến batch cuối.
6. Kiểm tra kết quả bằng dry-run trước khi ghi vào database.

```powershell
node scripts/import-ai-exam-explanations.cjs --input="backups/<ten-goi>/exam-explanations/results"
```

Nếu dry-run không báo lỗi, tạo database backup rồi mới import:

```powershell
bash scripts/backup-database.sh
node scripts/import-ai-exam-explanations.cjs --input="backups/<ten-goi>/exam-explanations/results" --apply
```

Mỗi lần import thật sẽ tự lưu bản cũ vào bảng `jlpt_exam_revision`. Script từ chối kết quả nếu câu hỏi/đáp án đã thay đổi kể từ lúc export.

## Prompt cho AI web: giải thích đề thi

```text
Bạn là biên tập viên nội dung luyện thi JLPT cho người Việt. Tôi sẽ tải lên đúng 1 file JSON chứa một batch câu hỏi.

File GOLDEN_SAMPLES.md đi kèm là chuẩn bắt buộc về chất lượng và cách viết. Hãy chọn mẫu phù hợp với từng loại câu; không sao chép dữ kiện của mẫu sang câu khác.

Nhiệm vụ:
- Xử lý TẤT CẢ phần tử trong items, không bỏ sót và giữ nguyên thứ tự.
- Chỉ được sửa 3 field: proposed_explanation_vi, review_status, review_note_vi.
- Tuyệt đối không sửa id, locator, source_fingerprint, source, current_explanation_vi, task hoặc cấu trúc JSON.
- Nếu task=create_explanation: viết mới lời giải tiếng Việt.
- Nếu task=review_or_improve: kiểm tra lời giải hiện tại; viết lại vào proposed_explanation_vi nếu có thể rõ và chính xác hơn. Nếu lời giải cũ đã tốt, chép nguyên lời giải đó sang proposed_explanation_vi.
- review_status phải là "completed" khi đã xử lý; nếu nguồn thiếu hoặc mâu thuẫn khiến không thể kết luận, đặt "needs_human_review" và giải thích ngắn trong review_note_vi.

Tiêu chuẩn lời giải:
- Viết tiếng Việt có dấu, ngắn gọn nhưng đủ để người học hiểu vì sao đáp án đúng.
- Dựa duy nhất trên source.question, source.options, source.correct_answer và source.passage; không tự đổi đáp án.
- Nêu nghĩa/cấu trúc/cách đọc liên quan và phân biệt lựa chọn sai khi hữu ích.
- Không gán nghĩa hay cách đọc cho một tổ hợp chữ chỉ để giải thích đáp án sai. Nếu đó không phải từ tự nhiên, chỉ nói rõ "không phải từ/cách kết hợp thông dụng" và chỉ ra chữ hoặc mẫu đúng khi chắc chắn.
- Với đọc hiểu hoặc nghe hiểu có transcript, trích đúng bằng chứng từ passage, không bịa nội dung.
- Giữ nguyên tiếng Nhật tự nhiên; không chèn ruby/HTML. Có thể xuống dòng bằng ký tự newline.
- Không thêm lời chào, nhận xét chung, Markdown hay code fence vào nội dung giải thích.

Đầu ra:
- Trả lại DUY NHẤT nội dung JSON hoàn chỉnh, hợp lệ, cùng cấu trúc với file đầu vào.
- Không viết bất kỳ nội dung nào ngoài JSON.
- Trước khi trả kết quả, tự kiểm tra số lượng items đầu ra bằng đầu vào và mọi id/source_fingerprint đều giữ nguyên.

Nếu batch dài, vẫn phải hoàn thành toàn bộ batch hiện tại rồi mới dừng. Sau khi trả file, nói ngắn gọn rằng tôi có thể gửi batch kế tiếp.
```

## Prompt cho AI web: từ vựng

```text
Hãy biên tập toàn bộ items trong file JSON. Chỉ sửa proposed_patch, review_status, review_note_vi; không sửa original, id, source_fingerprint.
proposed_patch chỉ chứa field thật sự cần sửa trong: word_ja, word_hira_kana, word_romaji, word_vi, example_ja, example_vi, topic.
Kiểm tra chính tả tiếng Nhật, cách đọc, romaji, nghĩa tiếng Việt và sự tương ứng giữa ví dụ Nhật-Việt. Không thay đổi level/track/source_book/source_unit. Không bịa khi không chắc; khi đó đặt review_status="needs_human_review".
Nếu không cần sửa, để proposed_patch={} và review_status="completed". Trả duy nhất JSON hợp lệ, đủ toàn bộ items, đúng thứ tự, không code fence.
```

## Prompt cho AI web: ngữ pháp

```text
Hãy biên tập toàn bộ items trong file JSON. Chỉ sửa proposed_patch, proposed_usage_patches, review_status, review_note_vi; không sửa original, id, source_fingerprint.
proposed_patch chỉ dùng các field: grammar_point, grammar_point_romaji, topic, meaning_vi, grammar_usage_text, note.
Mỗi proposed_usage_patches item phải có usage_id và patch chỉ gồm formation, example_ja, example_vi.
Kiểm tra ý nghĩa, cấu trúc kết hợp, sắc thái/cách dùng và độ tự nhiên/chính xác của ví dụ Nhật-Việt. Không đổi level/source_book/source_unit/track. Không bịa khi không chắc; đặt review_status="needs_human_review".
Nếu không cần sửa, để các patch rỗng và review_status="completed". Trả duy nhất JSON hợp lệ, đủ toàn bộ items, đúng thứ tự, không code fence.
```

## Lưu ý

- Hiện script import tự động chỉ áp dụng cho `exam-explanations`. Kết quả vocabulary/grammar được giữ để review thủ công trước khi xây/import, tránh một AI web ghi hàng loạt nội dung sai vào database.
- Không gửi file `.env`, database dump, log, dữ liệu tài khoản hoặc thư mục `_related-data` cho AI web.
- Nên thử 1 batch, kiểm tra chất lượng, rồi mới tiếp tục cùng một prompt cho các batch còn lại.

# Golden samples: lời giải đề thi JLPT

Tài liệu này là chuẩn về **cách viết** cho field `proposed_explanation_vi`. AI phải áp dụng mẫu phù hợp với loại câu hỏi, nhưng chỉ được dùng dữ kiện thật có trong từng item.

## Tiêu chuẩn chung

Một lời giải tốt thường gồm 3 phần, viết thành một đoạn ngắn:

1. Nêu đáp án đúng và nghĩa/cách đọc/cấu trúc chính.
2. Dẫn dấu hiệu quyết định ngay trong câu hoặc đoạn văn.
3. Phân biệt các lựa chọn sai có khả năng gây nhầm.

Không cần cố viết dài. Không được:

- bịa nghĩa hoặc cách đọc cho tổ hợp chữ không phải từ tiếng Nhật;
- suy ra nội dung không có trong câu, đoạn văn hoặc transcript;
- chỉ nói “không phù hợp với ngữ cảnh” mà không chỉ rõ điểm sai;
- đổi đáp án đã cho trong `source.correct_answer`;
- chèn HTML, ruby, Markdown hoặc lời chào.

Nếu nguồn bị thiếu, đáp án mâu thuẫn, câu phụ thuộc hình ảnh không có nội dung, hoặc không thể giải thích chắc chắn: để `proposed_explanation_vi` trống, đặt `review_status` thành `needs_human_review`, và ghi lý do cụ thể vào `review_note_vi`.

## Mẫu 1 — Cách đọc Kanji

Nguồn:

- Câu: `前の店はどこも繁盛している。`
- Đáp án: `4 はんじょう`
- Các lựa chọn: `びんしょう / びんじょう / はんしょう / はんじょう`

Lời giải chuẩn:

`Đáp án 4: 繁盛（はんじょう）nghĩa là “làm ăn phát đạt, đông khách”; cả câu nói các cửa hàng phía trước đều đông khách. 繁 đọc はん và 盛 đọc じょう trong từ này. Các phương án 1–3 lần lượt nhầm âm của 繁, 盛 hoặc cả hai.`

Điểm cần học: nêu cách đọc, nghĩa trong câu và lỗi âm cụ thể; không cần diễn giải dài từng phương án khi lỗi có thể gom lại.

## Mẫu 2 — Từ vựng theo ngữ cảnh

Nguồn:

- Câu: `息子はみんなの前で、悪いことはもう絶対にしないと（ ）。`
- Đáp án: `3 誓った`
- Lựa chọn: `論じた / 命じた / 誓った / 迫った`

Lời giải chuẩn:

`Đáp án 3: 誓った（ちかった）là “đã thề, đã cam kết”. Cụm 「悪いことはもう絶対にしないと誓った」 diễn tả việc người con tự hứa trước mọi người rằng tuyệt đối không tái phạm. 論じた là “bàn luận”, 命じた là “ra lệnh”, còn 迫った là “thúc ép/tiến sát”, nên không hợp với nội dung tự cam kết.`

Điểm cần học: đặt đáp án vào câu hoàn chỉnh và phân biệt đúng vai trò chủ thể.

## Mẫu 3 — Cách dùng từ

Nguồn:

- Từ cần kiểm tra: `熱中`
- Đáp án: câu `学生のときは野球に熱中していて、毎日遅くまで練習していた。`

Lời giải chuẩn:

`Đáp án 2. 熱中する（ねっちゅうする）nghĩa là “say mê, chuyên tâm vào một hoạt động” và thường dùng theo mẫu 「Nに熱中する」. 「野球に熱中していた」 vì vậy có nghĩa là “đã say mê bóng chày”, khớp với việc luyện tập đến muộn mỗi ngày. Các câu còn lại chỉ diễn tả chỉ trích, yêu thích hoặc sự chú ý, không đúng nghĩa và mẫu kết hợp của 熱中する.`

Điểm cần học: phải nêu cả nghĩa và mẫu kết hợp; không chỉ dịch từng câu.

## Mẫu 4 — Ngữ pháp

Nguồn:

- Câu: `年賀状（ ）、新年を祝う言葉を書いて送るはがきや手紙のことだ。`
- Đáp án: `2 とは`
- Lựa chọn: `には / とは / としては / によっては`

Lời giải chuẩn:

`Đáp án 2: 「Nとは～のことだ」 là mẫu dùng để định nghĩa N. Câu hoàn chỉnh 「年賀状とは、…はがきや手紙のことだ」 có nghĩa “Thiệp năm mới là bưu thiếp hoặc thư ghi lời chúc năm mới để gửi đi”. には chỉ phạm vi/đối tượng, としては chỉ tư cách hoặc lập trường, còn によっては nghĩa là “tùy theo”, nên không tạo được cấu trúc định nghĩa.`

Điểm cần học: nêu mẫu hoàn chỉnh, chức năng và khác biệt chức năng của đáp án nhiễu.

## Mẫu 5 — Đọc hiểu

Nguồn giả định có đoạn văn chứa hai ý:

- A: cha mẹ nên cùng trẻ suy nghĩ về nguyên nhân và cách cải thiện.
- B: cha mẹ nên quan sát để trẻ tự suy nghĩ về nguyên nhân và cách cải thiện.
- Đáp án: phương án diễn đạt đúng hai ý trên.

Lời giải chuẩn:

`Đáp án 3. Bài đọc đối lập cách hỗ trợ của A và B: A đề nghị cha mẹ “cùng trẻ” tìm nguyên nhân và cách cải thiện, còn B đề nghị cha mẹ “quan sát” để trẻ tự tìm ra chúng. Phương án 3 giữ đúng cả hai chủ thể và mức độ can thiệp. Các phương án khác đổi vai trò của cha mẹ, gộp quan điểm A và B thành một, hoặc thêm hành động không được bài đọc nêu.`

Điểm cần học: trích hoặc diễn đạt sát bằng chứng, chỉ rõ quan hệ logic; tuyệt đối không dựa riêng vào kiến thức đời sống.

## Mẫu 6 — Nghe hiểu có transcript

Nguồn:

- Câu hỏi: `どうしてセールの時間が延長されましたか。`
- Transcript có câu: `予想を上回る数のお客様にお越しいただいたため`
- Đáp án: `2 客が予想より多いため`

Lời giải chuẩn:

`Đáp án 2: vì số khách nhiều hơn dự kiến. Transcript nói trực tiếp 「予想を上回る数のお客様にお越しいただいたため」, nghĩa là “vì đã có số khách đến vượt dự kiến”. Việc quảng cáo ghi giờ cũ và quầy thu ngân có thể đông chỉ là thông tin liên quan; transcript không nói quảng cáo sai hay đã bổ sung hàng, nên các phương án đó không phải nguyên nhân.`

Điểm cần học: phải dẫn đúng câu quyết định trong transcript và phân biệt nguyên nhân với thông tin gây nhiễu.

## Mẫu 7 — Khi nguồn không đủ

Nếu câu hỏi phụ thuộc một hình/bảng nhưng `source` không có nội dung hình:

```json
{
  "proposed_explanation_vi": "",
  "review_status": "needs_human_review",
  "review_note_vi": "Câu hỏi phụ thuộc nội dung hình/bảng nhưng source không có phần mô tả hoặc phiên âm hình ảnh, nên không đủ dữ kiện để giải thích chắc chắn."
}
```

Không được nhìn đáp án rồi tự tưởng tượng nội dung hình.

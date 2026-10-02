# Danh sách nghiệm thu trước khi giao máy

Chạy toàn bộ danh sách này trên **máy thật sẽ dùng ở khách sạn**, sau khi cài đặt
và trước khi lễ tân bắt đầu dùng. Mỗi mục phải đạt.

Ghi lại kết quả — `Kas.cmd --diagnose` tự động ghi `logs\deployment-report.json`,
đó là bằng chứng cho phần lớn danh sách này.

---

## A. Cài đặt

| # | Việc kiểm tra | Cách kiểm tra | Đạt khi |
| --- | --- | --- | --- |
| A1 | Cài mới thành công | Nhấn đúp `Install-Kas.cmd` | Báo "Cai dat hoan tat" |
| A2 | Ba tệp lệnh có mặt | Xem thư mục cài đặt | Có `Kas.cmd`, `KasService.cmd`, `KasBackup.cmd` |
| A3 | Lối tắt Desktop | Nhìn màn hình nền | Có biểu tượng Kas |
| A4 | Lối tắt Start Menu | Mở Start, gõ "Kas" | Xuất hiện Kas |
| A5 | Có trong Apps & features | Settings → Apps | Có "Kas Booking Dispatch" |
| A6 | Nâng cấp giữ dữ liệu | Cài đè bản mới | `.env`, `server\uploads`, `logs` còn nguyên |
| A7 | Cấu hình đã điền | Mở `.env` | `DATABASE_URL` trỏ đúng cơ sở dữ liệu |

## B. Khởi động và tắt

| # | Việc kiểm tra | Cách kiểm tra | Đạt khi |
| --- | --- | --- | --- |
| B1 | Khởi động thủ công | Nhấn đúp `Kas.cmd` | Trình duyệt mở tại `http://localhost:3001` |
| B2 | Chỉ một tiến trình | Nhấn đúp `Kas.cmd` lần nữa | Chỉ mở trình duyệt, **không** khởi động thêm |
| B3 | Tắt an toàn | `Kas.cmd --stop` | Báo đã dừng; cổng 3001 được giải phóng |
| B4 | Khởi động lại | `Kas.cmd --restart` | Kas hoạt động trở lại |
| B5 | Tự chạy cùng Windows | Khởi động lại máy, **không đăng nhập gì thêm** | `Kas.cmd --health` báo khoẻ mạnh |
| B6 | Không cần cửa sổ nào | Sau B5, mở Task Manager | `node.exe` đang chạy, không có cửa sổ console |

> B5 cần Scheduled Task `Kas`, chỉ đăng ký được khi cài với quyền Administrator.
> Nếu bỏ qua, ghi rõ trong biên bản: **sau mỗi lần khởi động máy phải nhấn đúp `Kas.cmd`.**

## C. Ứng dụng

| # | Việc kiểm tra | Cách kiểm tra | Đạt khi |
| --- | --- | --- | --- |
| C1 | Đăng nhập được | Vào bằng tài khoản Admin | Vào được màn hình điều phối |
| C2 | Lễ tân chỉ thấy chi nhánh mình | Đăng nhập một tài khoản lễ tân | Không thấy đơn của chi nhánh khác |
| C3 | Cài được lên máy (PWA) | Mở qua `localhost`, tìm nút cài | Cài được; **địa chỉ LAN sẽ không có nút này** |
| C4 | Ảnh xác nhận | Mở một đơn đã có ảnh | Ảnh hiển thị |

## D. Sao lưu và khôi phục

| # | Việc kiểm tra | Cách kiểm tra | Đạt khi |
| --- | --- | --- | --- |
| D1 | Sao lưu tay | `KasBackup.cmd` | Có thư mục mới trong `backups\` |
| D2 | Bản sao lưu đầy đủ | Mở thư mục đó | Có `database.dump`, `uploads\`, `logs\`, `config.json`, `manifest.json` |
| D3 | Không lộ bí mật | Mở `config.json` | `DATABASE_URL`, `SESSION_SECRET` hiển thị là **đã ẩn** |
| D4 | Lịch sao lưu | `schtasks /Query /TN "Kas Backup"` | Có, chạy 22:00 hằng ngày |
| D5 | Khôi phục có đường lùi | Diễn tập trên cơ sở dữ liệu dùng thử | Kết thúc là `SUCCEEDED`, ứng dụng chạy lại |
| D6 | Hoàn tác khi lỗi | Xem `logs\restore.log` sau D5 | Có ghi điểm khôi phục đã tạo và đã kiểm tra |

> D5 chỉ chạy trên cơ sở dữ liệu dùng thử. Công cụ **từ chối** khôi phục vào
> `kas_production` và `kas_d1_test` — đó là chủ ý, không phải lỗi.

## E. Chẩn đoán và nhật ký

| # | Việc kiểm tra | Cách kiểm tra | Đạt khi |
| --- | --- | --- | --- |
| E1 | Chẩn đoán tổng thể | `Kas.cmd --diagnose` | PASS, hoặc chỉ còn WARNING đã được ghi nhận |
| E2 | Báo cáo triển khai | Mở `logs\deployment-report.json` | Có phiên bản, commit, trạng thái; **không có mật khẩu** |
| E3 | Phiên bản đúng | `Kas.cmd --version` | Đúng bản vừa cài |
| E4 | Nhật ký đầy đủ | `Kas.cmd --logs` | 8 tệp, kích thước hợp lý |
| E5 | `error.log` sạch | Mở `logs\error.log` | Trống, hoặc chỉ chứa lỗi đã biết và đã xử lý |
| E6 | Lệnh sai được báo | `Kas.cmd --khonghople` | In lỗi + hướng dẫn, **không khởi động ứng dụng** |

## F. Bàn giao

- [ ] Đã in `docs/launcher.md` hoặc lưu vào máy cho người vận hành
- [ ] Người vận hành đã tự làm được: khởi động, tắt, sao lưu, chạy chẩn đoán
- [ ] Đã nói rõ: **không dùng Task Manager để tắt Kas**
- [ ] Đã hẹn nơi cất bản sao lưu **ở máy khác** — bản sao cùng máy không chống được hỏng ổ đĩa
- [ ] Đã ghi lại mọi WARNING còn tồn tại và lý do chấp nhận

---

## Nếu có mục không đạt

Dừng lại. Ghi lại mục đó, chạy `Kas.cmd --diagnose`, và gửi kèm
`logs\deployment-report.json` với `logs\error.log`. Đừng bàn giao một máy còn
mục FAIL: mọi lỗi trong danh sách này đều là lỗi mà lễ tân sẽ gặp vào lúc đông
khách nhất.

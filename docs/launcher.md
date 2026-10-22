# Kas trên Windows — mọi lệnh bạn cần

Sau khi cài đặt, **không bao giờ phải gõ `npm`, `node` hay mở PowerShell** để dùng
Kas. Tất cả nằm trong ba tệp `.cmd` ở thư mục cài đặt.

---

## 1. Ba tệp, ba việc

| Tệp | Dùng khi nào |
| --- | --- |
| `Kas.cmd` | Bạn muốn **mở ứng dụng**. Nhấn đúp. |
| `KasService.cmd` | Windows tự gọi lúc **khởi động máy**. Bạn hiếm khi cần chạy tay. |
| `KasBackup.cmd` | Windows tự gọi **22:00 hằng ngày**. Chạy tay khi muốn sao lưu ngay. |

Nhấn đúp `Kas.cmd` là đủ cho công việc hằng ngày. Nếu Kas đã chạy nền, nó **không**
khởi động thêm tiến trình thứ hai — chỉ mở trình duyệt tới bản đang chạy.

---

## 2. Các lệnh của `Kas.cmd`

```
Kas.cmd                khởi động và mở trình duyệt
Kas.cmd --diagnose     kiểm tra toàn bộ hệ thống  (không thay đổi dữ liệu)
Kas.cmd --health       hỏi nhanh: Kas có đang chạy không?
Kas.cmd --version      phiên bản, commit, thời điểm build
Kas.cmd --logs         các tệp nhật ký nằm ở đâu, lớn bao nhiêu
Kas.cmd --restart      tắt an toàn rồi khởi động lại
Kas.cmd --stop         tắt an toàn
Kas.cmd --help         danh sách này
```

Gõ sai một tuỳ chọn sẽ **báo lỗi và in hướng dẫn** — nó không âm thầm khởi động
ứng dụng.

### Mã thoát (dùng cho script)

| Lệnh | 0 | 1 | 2 |
| --- | --- | --- | --- |
| `--diagnose` | PASS | WARNING | FAIL |
| `--health` | khoẻ mạnh | không phản hồi / CSDL lỗi | — |
| `--stop` | đã dừng | không có bản nào đang chạy | — |

---

## 3. Khởi động, tắt, khởi động lại

**Khởi động cùng Windows.** Trình cài đặt đăng ký Scheduled Task tên `Kas`, chạy
`KasService.cmd` lúc máy khởi động, dưới tài khoản SYSTEM, **không cần ai đăng
nhập** và không mở cửa sổ nào.

> Việc đăng ký này cần quyền Administrator. Nếu cài mà không có quyền đó, Kas vẫn
> chạy bình thường — chỉ là sau mỗi lần khởi động máy bạn phải nhấn đúp `Kas.cmd`.
> Chạy lại trình cài đặt bằng PowerShell (Administrator) để bật.

**Tắt an toàn:** `KasService.cmd stop` hoặc `Kas.cmd --stop`. Máy chủ hoàn tất các
yêu cầu đang xử lý rồi mới đóng kết nối cơ sở dữ liệu.

> **Đừng dùng `taskkill` hay Task Manager.** Chúng cắt ngang giữa chừng — đúng vào
> lúc một đơn đang được ghi.

**Khởi động lại:** `Kas.cmd --restart`. Nếu Kas đang chạy nền thì nó sẽ được giao
lại cho Windows, chứ không bị buộc vào cửa sổ bạn vừa gõ lệnh.

---

## 4. Khi có sự cố — chạy `Kas.cmd --diagnose`

Lệnh này kiểm tra 15 mục và in **lỗi trước, cảnh báo sau, mục đạt cuối cùng**:

Node.js · Windows · quyền Administrator · PostgreSQL · migration · build máy chủ ·
build giao diện · thư mục ảnh · thư mục nhật ký · thư mục sao lưu · dung lượng đĩa
· sức khoẻ ứng dụng · Scheduled Task khởi động · Scheduled Task sao lưu · bản sao
lưu gần nhất

Nó **không sửa gì cả** — chẩn đoán mà tự sửa sẽ xoá mất bằng chứng về nguyên nhân.

Mỗi lần chạy, nó cũng ghi `logs\deployment-report.json`. Đây là tệp nên gửi kèm
khi hỏi ai đó về sự cố: **trong đó không có mật khẩu hay chuỗi kết nối nào.**

### Ý nghĩa của FAIL và WARNING

**FAIL = Kas không phục vụ được đơn nào.** Ví dụ: không kết nối được PostgreSQL,
chưa build, không ghi được thư mục ảnh, đĩa gần đầy.

**WARNING = Kas chạy được, nhưng có việc cần xem.** Ví dụ: không có quyền
Administrator, chưa đăng ký khởi động cùng Windows, chưa có bản sao lưu nào,
hoặc **Kas hiện không chạy** — vì bạn thường chạy chẩn đoán đúng lúc nó đang tắt.

---

## 5. Nhật ký

`Kas.cmd --logs` cho biết vị trí và kích thước. Tất cả nằm trong `logs\`:

| Tệp | Nội dung |
| --- | --- |
| `startup.log` | kết quả kiểm tra mỗi lần khởi động |
| `launcher.log` | quyết định khi khởi động |
| `service.log` | giám sát: khởi động, khởi động lại, tắt |
| `server.log` | toàn bộ đầu ra của máy chủ |
| `error.log` | **chỉ lỗi** — có nội dung nghĩa là có vấn đề |
| `backup.log` | sao lưu |
| `restore.log` | khôi phục |
| `verification.log` | kết quả kiểm tra sao lưu / khôi phục |

Mỗi tệp tự xoay vòng ở 5 MB và giữ 5 thế hệ, nên nhật ký **không bao giờ làm đầy
ổ đĩa**. Tổng dung lượng tối đa khoảng 200 MB.

Máy chủ không bao giờ ghi mật khẩu, chuỗi kết nối, cookie hay số điện thoại thật
vào các tệp này.

---

## 6. Sự cố thường gặp

| Hiện tượng | Việc cần làm |
| --- | --- |
| Nhấn đúp không có gì xảy ra | `Kas.cmd --diagnose` — thường là chưa build hoặc PostgreSQL chưa chạy |
| "Cổng 3001 đang bị chiếm" | Một chương trình khác giữ cổng. Đóng nó, hoặc đổi `PORT` trong `.env` |
| Kas chạy nhưng trang trắng | Chưa build giao diện — chạy lại trình cài đặt |
| Sau khi khởi động máy Kas không tự chạy | Chưa đăng ký Scheduled Task — cài lại với quyền Administrator |
| Không có bản sao lưu nào | `Kas.cmd --diagnose` sẽ cảnh báo. Chạy `KasBackup.cmd` |
| Không cài được ứng dụng vào máy (PWA) | Phải mở qua `http://localhost:3001`, không phải địa chỉ LAN — xem [pwa-install.md](pwa-install.md) |

Nếu vẫn bế tắc: gửi `logs\deployment-report.json` và `logs\error.log`.

---

## 7. Liên quan

- [deployment.md](deployment.md) — cài đặt và mạng nội bộ
- [backup-restore.md](backup-restore.md) — sao lưu và khôi phục
- [production-runbook.md](production-runbook.md) — vận hành hằng ngày
- [production-checklist.md](production-checklist.md) — danh sách nghiệm thu

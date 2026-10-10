# Cài đặt Kas như một ứng dụng (PWA) trên Windows

Kas có thể cài như một ứng dụng độc lập trên Windows bằng Chrome hoặc Edge.

## ⚠️ Yêu cầu bắt buộc: kết nối bảo mật (https)

Chrome và Edge **chỉ cho phép cài ứng dụng** khi trang được mở qua:

- `https://…` (có chứng chỉ hợp lệ), hoặc
- `http://localhost` / `http://127.0.0.1` (ngay trên chính máy chủ).

Địa chỉ LAN dạng `http://192.168.1.10:3001` **không** thoả điều kiện này. Trên
địa chỉ đó trình duyệt không chạy service worker, nên **không có nút “Cài ứng
dụng”** trong Kas và **cũng không có biểu tượng cài đặt** trên thanh địa chỉ.
Đây là quy định của trình duyệt, không phải lỗi cấu hình của Kas — không có
thay đổi nào trong manifest hay icon khắc phục được.

Khi mở bằng địa chỉ `http://` LAN, Kas sẽ hiển thị dòng giải thích ở góc dưới
bên trái thay vì im lặng.

**Cách khắc phục:** phục vụ Kas qua `https://<tên-miền>` theo
[production-deployment.md](production-deployment.md), hoặc cài trực tiếp trên
máy chủ bằng `http://localhost:3001`.

### Cách nhanh nhất trên máy chủ: `Kas.cmd`

Nhấn đúp **`Kas.cmd`** ở thư mục gốc của Kas. Trình khởi động sẽ kiểm tra
Node/cổng/bản build/cấu hình, khởi động máy chủ nếu chưa chạy, rồi mở trình
duyệt tại **`http://localhost:3001`** — đúng địa chỉ mà Chrome và Edge cho phép
cài ứng dụng. Nếu Kas đã chạy sẵn, trình khởi động chỉ mở trình duyệt chứ không
khởi động thêm tiến trình nào. Nhật ký nằm ở `logs/launcher.log`.

## Cài đặt

1. Mở Kas trong **Chrome** hoặc **Edge** bằng địa chỉ **`https://`** của máy chủ
   (xem mục cảnh báo ở trên).
2. Đăng nhập một lần để chắc chắn trang tải đúng.
3. Cài đặt:
   - **Chrome:** biểu tượng **Cài đặt** (màn hình có mũi tên) ở cuối thanh địa
     chỉ → **Cài đặt**. Hoặc menu ⋮ → **Cài Kas…**
   - **Edge:** menu **⋯** → **Ứng dụng** → **Cài đặt trang này dưới dạng ứng dụng**.
   - Nếu nút **“Cài ứng dụng”** hiện trong Kas (góc dưới bên trái), bạn có thể bấm
     trực tiếp.
4. Xác nhận. Kas mở trong cửa sổ riêng, không có thanh địa chỉ (chế độ
   `standalone`).

## Ghim vào thanh tác vụ (Taskbar)

- Sau khi cài, chuột phải vào biểu tượng Kas trên thanh tác vụ → **Ghim vào thanh
  tác vụ** (Pin to taskbar).
- Hoặc trong Chrome/Edge: menu ứng dụng → **Tạo lối tắt** / **Ghim vào Start**.

## Cập nhật

Khi có bản mới, Kas hiển thị **“Có phiên bản mới”** ở góc dưới bên trái. Bấm
**Cập nhật** để tải lại phiên bản mới. Không cần gỡ cài đặt.

## Lưu ý về dữ liệu

- Service worker chỉ lưu **giao diện tĩnh** (JS/CSS/hình ảnh) để mở nhanh và
  chịu được mất mạng tạm thời.
- **Không** có dữ liệu đặt phòng hay phiên đăng nhập nào được lưu trong cache của
  service worker — mọi dữ liệu vận hành luôn được lấy trực tiếp từ máy chủ.
- Khi mất mạng, Kas hiển thị cảnh báo “Mất kết nối mạng” và giữ nguyên dữ liệu
  đang xem thay vì hiển thị danh sách trống.

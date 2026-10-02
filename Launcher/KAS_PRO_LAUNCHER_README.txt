KAS PRO LAUNCHER — CÁCH CÀI AN TOÀN

File installer được để ở dạng .txt để trình duyệt/Windows không coi nó là file thực thi tải từ Internet.
Launcher thật sẽ được PowerShell tạo trực tiếp trên máy tại:

%LOCALAPPDATA%\KAS-Pro-Launcher

Nó KHÔNG tạo launcher trong C:\Kas nên Git working tree vẫn sạch.

CÁCH CÀI
1. Tải file KAS_PRO_LAUNCHER_INSTALLER.txt.
2. Mở file bằng Notepad.
3. Nhấn Ctrl+A rồi Ctrl+C.
4. Mở Windows PowerShell bình thường.
5. Dán toàn bộ bằng Ctrl+V và nhấn Enter.
6. Chờ dòng: KAS PRO LAUNCHER ĐÃ ĐƯỢC CÀI THÀNH CÔNG.
7. Ngoài Desktop sẽ có:
   - KAS PRO LAUNCHER
   - KAS PRO STOP

CÁCH DÙNG
- Nhấp đúp KAS PRO LAUNCHER.
- Chọn [1] để restart toàn bộ frontend + backend + Cloudflare.
- Launcher tự tạo URL trycloudflare.com mới, thêm hostname vào Vite, mở trình duyệt và sao chép URL.
- Chọn [3] hoặc nhấp KAS PRO STOP để dừng toàn bộ.

MENU
[1] Khởi động lại toàn bộ + Cloudflare
[2] Khởi động local không Cloudflare
[3] Dừng toàn bộ
[4] Trạng thái
[5] Mở/sao chép URL Cloudflare
[6] Kiểm tra /api/health và /api/ready
[7] Chạy db:generate + typecheck + lint + test + build
[8] Xem log Cloudflare
[9] Xem Git branch/status

LƯU Ý
- Project phải nằm tại C:\Kas.
- cloudflared và Node.js phải được cài sẵn.
- Quick Tunnel chỉ dành cho kiểm thử; URL đổi mỗi lần chạy lại.
- Không dùng dữ liệu khách thật qua Quick Tunnel.

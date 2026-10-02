# Triển khai Kas

> **CÁCH TRIỂN KHAI HIỆN TẠI: Windows + PostgreSQL.**
>
> Cài đặt bằng `scripts\production\windows\Install-Kas.cmd`, khởi động bằng
> `Kas.cmd`, chạy nền bằng Scheduled Task `Kas` → `KasService.cmd`.
> **Mọi lệnh vận hành nằm trong [launcher.md](launcher.md).**
> Danh sách nghiệm thu: [production-checklist.md](production-checklist.md).
>
> Cơ sở dữ liệu là **PostgreSQL 17**, không phải SQLite. Phần bên dưới còn nói
> "SQLite" là di sản của giai đoạn thử nghiệm; mọi thứ khác về mạng nội bộ,
> tường lửa và máy lễ tân vẫn đúng.

## Tóm tắt: từ máy trắng đến Kas đang chạy

1. Cài **Node.js LTS** (https://nodejs.org) và **PostgreSQL 17**.
2. Tạo cơ sở dữ liệu và người dùng `kas_app`.
3. Giải nén bản phát hành, nhấn đúp `Install-Kas.cmd`.
   *Muốn Kas tự chạy cùng Windows thì mở bằng PowerShell (Administrator).*
4. Mở `.env` trong thư mục cài đặt, điền `DATABASE_URL`.
5. Chạy `npm run db:migrate` một lần để tạo schema.
6. Nhấn đúp `Kas.cmd`.
7. Chạy `Kas.cmd --diagnose` — phải PASS, hoặc chỉ còn WARNING bạn chấp nhận.

---


Kas chạy trên **một máy chủ trung tâm** (máy của Admin). Các máy lễ tân chỉ mở
trình duyệt trỏ tới máy chủ đó. Tất cả dùng chung **một** cơ sở dữ liệu SQLite
nằm trên máy chủ.

## Cài đặt trên máy chủ (máy Admin)

```bash
npm install
npm run db:migrate
npm run db:seed
npm run build      # build cả server và client
npm start          # chạy backend (mặc định cổng 3001), phục vụ luôn giao diện đã build
```

> **`npm run dev` KHÔNG BAO GIỜ dùng cho máy chủ thật.**
>
> Máy chủ dev (cổng 5173) phục vụ `/src/main.tsx` và `@vite/client`, **không**
> phục vụ `manifest.webmanifest` hay service worker đã build. Ứng dụng vẫn chạy
> bình thường — đăng nhập, điều phối, đặt phòng đều được, vì Vite chuyển tiếp
> `/api` sang backend — nên **không có dấu hiệu gì cho thấy sai**. Triệu chứng
> duy nhất là không cài được ứng dụng: không có nút cài, không có biểu tượng cài
> trên thanh địa chỉ.
>
> Đây là lỗi đã xảy ra thật: tunnel trỏ vào cổng 5173 và cả bản triển khai chạy
> ở chế độ phát triển. Máy chủ thật chỉ khởi động bằng `KasService.cmd` (hoặc
> Scheduled Task "Kas"), phục vụ mọi thứ trên **một cổng duy nhất, 3001**.
>
> Kiểm tra bất cứ lúc nào: `Kas.cmd --diagnose` — mục `clientBuild` sẽ báo lỗi
> nếu địa chỉ đang phục vụ bản dev thay vì bản build.

Trong lúc phát triển (chỉ trên máy lập trình viên) có thể dùng:

```bash
npm run dev        # backend :3001 + client dev :5173 (client proxy /api sang backend)
```

- Backend đã lắng nghe trên `0.0.0.0`, nên các máy khác trong LAN truy cập được.
- Cấu hình `.env`: đặt `SESSION_SECRET` và tài khoản Admin ban đầu
  (`INITIAL_ADMIN_*`). Ở môi trường nội bộ HTTP, để `SESSION_COOKIE_SECURE=false`.

## Máy lễ tân

1. Tìm địa chỉ IP LAN của máy chủ (ví dụ `ipconfig` → `192.168.1.10`).
2. Trên máy lễ tân, mở Chrome/Edge tới `http://192.168.1.10:3001`.
3. Đăng nhập bằng tài khoản lễ tân do Admin tạo.
4. (Tùy chọn) Cài đặt Kas như một ứng dụng — xem `pwa-install.md`.

## Cơ sở dữ liệu dùng chung

- Chỉ có **một** file SQLite trên máy chủ (theo `DATABASE_URL`, ví dụ
  `file:./data.db`).
- **Không** sao chép file `.db` sang từng máy lễ tân — như vậy dữ liệu sẽ bị tách
  rời. Mọi máy phải cùng gọi API tới máy chủ.

## Ảnh chứng minh (proof screenshots)

- Ảnh lễ tân gửi để Admin kiểm tra được lưu trên **ổ đĩa của máy chủ**, không lưu
  trong SQLite (SQLite chỉ giữ metadata + đường dẫn an toàn do máy chủ tự sinh).
- Thư mục lưu ảnh do biến môi trường `PROOF_UPLOAD_DIR` quyết định (mặc định
  `server/uploads/booking-proofs`, đã được `.gitignore`). Đường dẫn tương đối được
  tính từ thư mục gốc của repo; có thể đặt đường dẫn tuyệt đối (ví dụ một ổ dữ
  liệu riêng) nếu muốn.
- Thư mục này phải **cùng nằm trên máy chủ** với file `.db` để dữ liệu và ảnh luôn
  đồng bộ. Cấp quyền ghi cho tài khoản chạy Kas.

## OCR ảnh chứng minh (tùy chọn, chỉ để đọc thông tin)

- OCR **chỉ đọc** thông tin từ ảnh (mã booking, ngày, tổng tiền, thanh toán…) để
  hỗ trợ Admin. Nó **không** tự duyệt/từ chối và **không** so sánh với đơn gốc.
  Admin vẫn luôn tự kiểm tra ảnh.
- Mặc định **tắt**: `PROOF_OCR_ENABLED=false`. Khi tắt, nộp ảnh vẫn hoạt động bình
  thường, mỗi lần phân tích được ghi trạng thái `DISABLED`, Admin xem ảnh thủ công.
- Khi bật (`PROOF_OCR_ENABLED=true`, ngôn ngữ `PROOF_OCR_LANGUAGE=eng+vie`) cần cài
  gói **tùy chọn** `tesseract.js`:

  ```bash
  npm install tesseract.js -w server
  ```

  Nếu OCR lỗi hoặc chưa cài gói, việc nộp ảnh **vẫn thành công** — lần phân tích chỉ
  được ghi là `FAILED` (thông báo đã được làm sạch, không lộ đường dẫn máy chủ).
- Chỉ **Admin** đọc được dữ liệu OCR; lễ tân không thấy. Kết quả OCR (văn bản + các
  trường) lưu trong SQLite dưới dạng **chữ** (không lưu ảnh trong DB), nên đã được
  sao lưu cùng `data.db`. Không lưu byte ảnh hay đường dẫn hệ thống tệp trong DB.

## Đối chiếu ảnh với đơn (compare — chỉ hỗ trợ)

- Sau khi OCR xong, hệ thống **tự đối chiếu** dữ liệu OCR với đơn Admin đã gửi và
  lưu một bản kết quả (KHỚP / CẦN KIỂM TRA / CÓ SAI KHÁC / CHƯA CÓ KẾT QUẢ). Đây là
  **logic cục bộ, xác định** — không dùng AI, không gọi dịch vụ ngoài.
- Kết quả **chỉ mang tính hỗ trợ**: hệ thống **không** tự duyệt/từ chối và **không**
  đổi trạng thái đơn/ảnh. Admin vẫn là người quyết định cuối cùng.
- Mỗi lần phân tích OCR mới tạo một bản đối chiếu mới; các bản cũ được giữ lại. Kết
  quả lưu dưới dạng **chữ (JSON)** trong SQLite, sao lưu cùng `data.db`. Chỉ Admin
  đọc được; lễ tân không thấy.
- Bản C.3.5 bổ sung **giải thích thông minh** (chênh lệch tiền/ngày/đêm/số phòng, ký
  tự sai trong mã Booking, checklist ghi chú, mức độ tin cậy OCR, gợi ý kiểm tra) —
  tất cả đều là **logic cục bộ, xác định**, cộng thêm vào JSON hiện có. **Không** đổi
  schema, **không** thêm migration, và các bản đối chiếu C.3 cũ vẫn đọc được. Vẫn chỉ
  hỗ trợ, không tự duyệt/từ chối.

## Công cụ dữ liệu test (CHỈ dành cho phát triển)

- Bộ công cụ demo/reset chỉ bật khi `ENABLE_DEV_TEST_TOOLS=true` **và** `NODE_ENV`
  không phải production. **Tuyệt đối không bật trong production** — ngay cả khi lỡ đặt
  cờ, mọi endpoint `/api/dev-test/*` vẫn trả `404` và không hiện UI test.
- Trước khi bàn giao vận hành thật, chạy **một lần** (thủ công, không phải nút bấm):

  ```bash
  npm run data:prepare-production
  ```

  Lệnh này yêu cầu gõ cụm từ `PREPARE KAS FOR OFFICIAL USE`, **sao lưu** `data.db` +
  thư mục upload + `manifest.json` vào `backups/pre-official-<thời gian>/` trước khi
  xóa, rồi xóa toàn bộ dữ liệu vận hành (demo lẫn thật), giữ nguyên **toàn bộ chi
  nhánh đã cấu hình cùng tên khách sạn trên các nền tảng** (`BranchSourceAlias`), tài
  khoản Admin và cấu hình, và vô hiệu hóa `reception_test`. Nếu sao lưu thất bại,
  lệnh **hủy** và không xóa gì.
- Thư mục `backups/` đã được `.gitignore`; hãy sao chép ra ổ khác và không commit.
- Chi tiết: xem `docs/testing-8-branches.md`.

## Quản lý chi nhánh khi đã chạy thật (C.3.7)

- Thêm chi nhánh, đổi số/tên/địa chỉ chi nhánh và đổi tên khách sạn trên
  Booking.com / Agoda đều làm **trong giao diện Admin** (*Khách sạn & chi nhánh*) —
  không cần sửa mã nguồn, không cần deploy lại.
- `npm run db:migrate` thêm `Branch.branchNumber` (điền sẵn cho các chi nhánh có
  sẵn), `BranchSourceAlias` và `BranchChangeLog`. Đây là migration **cộng thêm**:
  ứng dụng chạy đúng ngay sau khi migrate.
- Chạy `npm run db:seed` **một lần** sau khi migrate để nạp toàn bộ tên khách sạn
  Booking.com/Agoda hiện có vào bảng alias. Seed là **idempotent** và không bao giờ
  ghi đè tên hay số chi nhánh mà Admin đã sửa.
- Không xóa chi nhánh — dùng **Vô hiệu hóa** để giữ nguyên lịch sử.
- Chi tiết: xem `docs/branch-management.md`.

## Tường lửa Windows

Nếu máy lễ tân không mở được Kas, cho phép cổng của máy chủ (ví dụ 3001) qua
**Windows Defender Firewall** → *Inbound Rules* → *New Rule* → *Port* → TCP 3001
→ Allow (Private network).

## Sao lưu (khuyến nghị)

- Sao lưu định kỳ file `data.db` của máy chủ (ví dụ hằng ngày sang ổ khác/USB).
- Nên sao lưu khi không có thao tác ghi (ví dụ cuối ngày) để tránh chép giữa lúc
  đang ghi. Có thể sao lưu cả các file `data.db-wal` / `data.db-shm` nếu tồn tại.
- Sao lưu **kèm** thư mục `PROOF_UPLOAD_DIR` cùng lúc với `data.db` — nếu thiếu
  ảnh, phần kiểm tra chứng minh sẽ mất bằng chứng dù metadata vẫn còn.

## Không dùng Docker

Không bắt buộc Docker. Kas chạy trực tiếp bằng Node.js trên máy Windows.

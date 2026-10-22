# Quản lý khách sạn & chi nhánh (Branch management)

Milestone C.3.7. Từ đây, việc **thêm chi nhánh, đổi số chi nhánh, đổi tên nội bộ,
đổi địa chỉ, thêm/đổi tên khách sạn trên Booking.com hoặc Agoda, bật/tắt chi
nhánh** là thao tác của Admin trong giao diện — **không còn phải sửa mã nguồn**
(`branchMatcher.ts`, seed, bảng alias hardcode).

Trang: **Khách sạn & chi nhánh** (`/app/branches`) — chỉ Admin.

---

## 1. Các trường của một chi nhánh

| Trường | Bắt buộc | Ý nghĩa |
| --- | --- | --- |
| `branchNumber` — Số chi nhánh | ✔ | Nhãn cho người dùng: “Chi nhánh 2”. Số nguyên dương, **duy nhất trong các chi nhánh đang hoạt động**, sửa được. |
| `code` — Stable branch code | ✔ | Định danh cố định (`BUI_THI_XUAN_40`). **Không đổi được sau khi tạo.** |
| `address` — Địa chỉ | ✔ | Địa chỉ lưu trữ. Đây là giá trị “Khách sạn” trong nghiệp vụ. |
| `hotelName` — Tên nội bộ | ✔ | Tên hiển thị nội bộ. Không phải tên trên nền tảng. |
| `active` | ✔ | Đang hoạt động / đã vô hiệu hóa. |
| `breakfastIncluded` | ✔ | Cấu hình ăn sáng của chi nhánh (xem §12). |
| `phone`, `email`, `contactName`, `note` | ✖ | Thông tin liên hệ nội bộ, chỉ Admin thấy. |
| `aliases` | ✖ | Tên khách sạn trên từng nền tảng (bảng `BranchSourceAlias`). |

Không có trường “display order” riêng: **`branchNumber` chính là thứ tự hiển thị**
(danh sách sắp theo số chi nhánh), nên không tạo thêm trường trùng chức năng.

---

## 2. Số chi nhánh ≠ stable code

| | Số chi nhánh | Stable code |
| --- | --- | --- |
| Dùng để | hiển thị cho người vận hành | định tuyến parser + phân quyền |
| Sửa được | ✔ | ✖ (cố định sau khi tạo) |
| Duy nhất | trong các chi nhánh **đang hoạt động** | tuyệt đối |
| Sinh từ | Admin nhập | gợi ý từ địa chỉ, Admin sửa trước khi tạo |

**Số chi nhánh không bao giờ là khóa phân quyền.** Mọi kiểm tra quyền và mọi liên
kết dữ liệu dùng `branchId` / `code`. Đổi số chi nhánh **không** đổi id, không đổi
code, và **không** chuyển đơn cũ sang chi nhánh khác.

Gợi ý stable code sinh từ địa chỉ theo đúng quy ước sẵn có (tên đường trước, số
nhà sau; dải số lấy phần đầu):

```
05 Trương Định              -> TRUONG_DINH_05
260 Lý Tự Trọng             -> LY_TU_TRONG_260
47A Nguyễn Trãi             -> NGUYEN_TRAI_47A
170-172-174 Nguyễn Thái Bình -> NGUYEN_THAI_BINH_170
40-42 Bùi Thị Xuân          -> BUI_THI_XUAN_40
```

Chỉ nhận `A–Z`, `0–9`, `_`.

---

## 3. Tên nội bộ ≠ tên trên nền tảng

- **Tên nội bộ** (`hotelName`) là nhãn nội bộ của chi nhánh.
- **Tên trên nền tảng** (`BranchSourceAlias`) là tên khách sạn mà Booking.com /
  Agoda in ra trong văn bản dán vào.

Một chi nhánh có thể có **nhiều tên trên nhiều nền tảng**, và tên đó **đổi theo
thời gian**. Ví dụ:

```
Chi nhánh 2 · LY_TU_TRONG_260 · 260 Lý Tự Trọng
  Booking.com : Bamboo Water Hotel               (tên hiện tại)
                Luxury Elegance Hotel Ben Thanh  (tên cũ, vẫn nhận đơn)
                Luxury Elegance Ben Thanh
  Agoda       : KAS Elegance Hotel
```

Đổi tên trên nền tảng **không** đổi địa chỉ chi nhánh, **không** sửa đơn đã lưu.

---

## 4. Thêm chi nhánh

1. **Khách sạn & chi nhánh → Thêm khách sạn / chi nhánh**.
2. Nhập **Số chi nhánh**, **Tên nội bộ**, **Địa chỉ**.
3. **Mã chi nhánh** được gợi ý tự động từ địa chỉ — sửa lại nếu cần, vì sau khi
   tạo sẽ cố định.
4. Chọn **Có ăn sáng / Không ăn sáng** và trạng thái hoạt động.
5. (Tuỳ chọn) thêm tên Booking.com và tên Agoda. Tên chưa lưu có thể xóa lại.
6. Xem khối **Xem trước** (`Chi nhánh 9 / địa chỉ / mã`) rồi bấm **Tạo chi nhánh**.

Chi nhánh chỉ được tạo sau khi Admin xác nhận. Nếu bất kỳ tên nào bị trùng, **cả
thao tác bị từ chối** — không tạo ra chi nhánh cấu hình dở dang.

Chi nhánh **mới** chỉ định tuyến theo các alias Admin cấu hình: tên nội bộ của nó
không tham gia đối chiếu gần đúng, nên không thể “cướp” đơn của chi nhánh khác.

---

## 5. Đổi tên / đổi số / đổi địa chỉ

**Chỉnh sửa** cho phép sửa số chi nhánh, tên nội bộ, địa chỉ, ăn sáng, liên hệ và
trạng thái. Không sửa được: id, stable code, `branchId` của đơn cũ.

Khi đổi địa chỉ:

- Màn hình mới hiển thị địa chỉ mới.
- Đơn/ảnh/sự cố/thông báo cũ **vẫn thuộc đúng chi nhánh đó** (`branchId` không đổi).
- Trường `hotelName` đã lưu trong đơn cũ là **lịch sử** và không bị ghi đè.
- Thay đổi được ghi vào nhật ký (§8).

---

## 6. Tên trên nền tảng: thêm, đổi tên, tắt

**Quản lý tên trên nền tảng** trên từng dòng.

- **Thêm**: chọn nguồn (Booking.com / Agoda) + nhập tên.
- **Đổi tên**: đổi tên hiển thị của alias; đơn cũ không bị ảnh hưởng.
- **Tắt**: alias ngừng định tuyến nhưng **hàng dữ liệu vẫn còn** (bật lại được).

Quy tắc an toàn:

- Tên cũ **vẫn tiếp tục nhận đơn** cho tới khi Admin tắt thủ công — không bao giờ
  mất hỗ trợ một cách âm thầm.
- Một tên (đã chuẩn hóa) chỉ được **một** chi nhánh đang bật sở hữu. Trùng ⇒ 409
  với thông báo chỉ rõ chi nhánh đang giữ tên đó.
- Tắt một alias sẽ **giải phóng** tên đó cho chi nhánh khác.

### Đối chiếu chính xác (EXACT) và gần đúng (SIMILARITY)

| Nguồn | Chế độ | Lý do |
| --- | --- | --- |
| **Agoda** | luôn **EXACT** (ép cứng, kể cả khi gửi `SIMILARITY`) | Mọi tên “KAS …” đều dùng chung từ *KAS*/*Hotel*; đối chiếu gần đúng có thể gửi nhầm chi nhánh. Tên thiếu/sai ⇒ để trống cho Admin chọn tay. |
| **Booking.com** | EXACT trước, sau đó SIMILARITY | Booking.com tự cắt ngắn tên trong email (*“Ben Than”*, *“Luxur”*), nên cần dung sai tiền tố. Alias khớp chính xác luôn thắng. |

Hai chi nhánh cùng điểm cao nhất ⇒ **AMBIGUOUS** ⇒ không chọn chi nhánh nào.
Tên lạ **không bao giờ** rơi về chi nhánh đầu tiên/mặc định.

---

## 7. Vô hiệu hóa thay vì xóa

Chi nhánh **không bị xóa cứng** khi còn đơn, ảnh, sự cố, thông báo, tài khoản,
lịch sử hoặc dữ liệu demo. Dùng **Vô hiệu hóa**:

- Không nhận định tuyến parser tự động, không nhận gửi đơn mới.
- Không hiện trong danh sách chọn chi nhánh cho lễ tân mới.
- Alias của nó không định tuyến đơn mới.
- **Dữ liệu cũ vẫn còn nguyên** và Admin vẫn xem được.

Milestone này **không** cung cấp xóa vĩnh viễn — vô hiệu hóa là cách được ưu tiên.

### Tài khoản lễ tân đang thuộc chi nhánh

Trước khi vô hiệu hóa, hộp thoại **cảnh báo** và liệt kê các tài khoản lễ tân
đang thuộc chi nhánh đó. Hệ thống **không tự chuyển và không tự khóa** tài khoản
nào. Admin tự chọn hành động tiếp theo trong **Quản lý tài khoản**: khóa tài
khoản, chuyển sang chi nhánh khác, hoặc kích hoạt lại chi nhánh.

---

## 8. Nhật ký thay đổi (audit)

Mỗi thay đổi ghi một dòng `BranchChangeLog` (bất biến): hành động, trường, giá trị
cũ/mới, người thực hiện, thời điểm.

`BRANCH_CREATED`, `BRANCH_NUMBER_CHANGED`, `BRANCH_NAME_CHANGED`,
`BRANCH_ADDRESS_CHANGED`, `BRANCH_BREAKFAST_CHANGED`, `BRANCH_CONTACT_CHANGED`,
`BRANCH_ACTIVATED`, `BRANCH_DEACTIVATED`, `ALIAS_ADDED`, `ALIAS_RENAMED`,
`ALIAS_ENABLED`, `ALIAS_DISABLED`, `ALIAS_REMOVED`.

Chỉ lưu **giá trị cấu hình** — không bao giờ lưu mật khẩu hay dữ liệu phiên.

Đọc qua `GET /api/admin/branches/:id/history` (Admin).

---

## 9. Gán lễ tân

- Form tạo/sửa lễ tân **chỉ hiện chi nhánh đang hoạt động** (`GET /api/branches`
  đã lọc `active`).
- Hiển thị dạng **“Chi nhánh 9 — 12 Nguyễn Huệ”**.
- Lưu **`branchId`**, không lưu số chi nhánh.
- Một lễ tân thường vẫn gắn với **đúng một** chi nhánh; không có bộ chuyển chi
  nhánh cho lễ tân thường. `reception_test` vẫn chỉ dùng trong môi trường phát
  triển.

---

## 10. Định tuyến của parser

```
route  ──▶ loadBranchConfigs()      // 1 truy vấn: chi nhánh active + alias active
       ──▶ parseBooking / parseAgodaBooking(rawText, configs)
       ──▶ branchMatcher            // hàm thuần, không chạm database
```

- `server/src/booking/branchConfig.ts` — nơi **duy nhất** đọc cấu hình định tuyến
  từ database.
- `branchMatcher.resolveBranchForSource(name, source, configs)` trả về đầy đủ:
  `branchId`, `branchCode`, `address`, `sourceAlias`, `confidence` (0–100),
  `reason` (`EXACT_ALIAS` | `SIMILARITY` | `AMBIGUOUS` | `UNKNOWN` | `NO_INPUT`).
- Chi nhánh đã vô hiệu hóa luôn có điểm 0 và bị loại khỏi mọi đối chiếu.

**Fallback sau migration:** một trong tám chi nhánh gốc mà **chưa có dòng alias
nào** sẽ tạm dùng bảng tên trong mã nguồn, nên hệ thống chạy đúng ngay sau khi
migrate mà chưa seed. Ngay khi chi nhánh đó có ít nhất một alias, cấu hình
database là nguồn sự thật duy nhất.

---

## 11. Công cụ demo (dev)

Bộ sinh dữ liệu demo đọc **toàn bộ chi nhánh đang hoạt động** từ database, không
cố định con số 8:

- Thêm chi nhánh thứ 9 ⇒ demo sinh cho cả chi nhánh 9.
- Vô hiệu hóa ⇒ demo bỏ qua chi nhánh đó.
- **Xóa dữ liệu demo** giữ nguyên toàn bộ chi nhánh và cấu hình tên nền tảng.

Giao diện lấy số chi nhánh từ server (“Tạo dữ liệu demo cho *N* chi nhánh”).

---

## 12. Ăn sáng — phạm vi hiện tại

`breakfastIncluded` là **cấu hình của chi nhánh**: lưu, hiển thị và ghi nhật ký.

Nó **không** đổi nội dung ghi chú PMS. Ghi chú vẫn suy ra từ chính văn bản đơn
(`KHONG AN SANG` / `AN SANG`), vì dữ liệu OTA gửi kèm đơn mới là dữ liệu ràng
buộc với khách. Nếu sau này muốn dùng cấu hình chi nhánh làm mặc định khi đơn
không nói gì, đó là một thay đổi có chủ đích riêng.

---

## 13. Reset chính thức (production)

`prepareForProduction` **giữ nguyên**: schema, toàn bộ chi nhánh (số, mã, địa chỉ,
ăn sáng, liên hệ), **toàn bộ `BranchSourceAlias`**, tài khoản Admin và cấu hình.
Chỉ dữ liệu vận hành bị xóa. Xem `docs/testing-8-branches.md`.

---

## 14. API (Admin-only)

```
GET    /api/admin/branches
GET    /api/admin/branches/suggest-code?address=…
GET    /api/admin/branches/:id
GET    /api/admin/branches/:id/history
GET    /api/admin/branches/:id/receptionists
POST   /api/admin/branches
PATCH  /api/admin/branches/:id                      # 'code' bị từ chối (422)
POST   /api/admin/branches/:id/aliases
PATCH  /api/admin/branches/:id/aliases/:aliasId
DELETE /api/admin/branches/:id/aliases/:aliasId
POST   /api/admin/branches/:id/deactivate
POST   /api/admin/branches/:id/activate
```

Lễ tân nhận **403** ở mọi route trên, kể cả các route đọc.

---

## 14b. Hạng phòng theo chi nhánh (C.3.8)

Mỗi chi nhánh còn có **danh sách hạng phòng và mã PMS riêng**, quản lý bằng bản
nháp có phiên bản, tách hoàn toàn khỏi tên khách sạn trên nền tảng ở trên. Xem
[room-class-mapping.md](room-class-mapping.md).

Truy cập: *Khách sạn & chi nhánh* → dòng chi nhánh → **Hạng phòng**.

## 15. Giới hạn đã biết

- **Stable code là bất biến.** Đổi code cần một luồng migration riêng (chưa có).
- **Không có xóa chi nhánh vĩnh viễn** trong milestone này — chỉ vô hiệu hóa.
- Số chi nhánh chỉ duy nhất trong nhóm **đang hoạt động**: hai chi nhánh đã vô
  hiệu hóa có thể trùng số. Khi kích hoạt lại, số bị trùng sẽ bị từ chối (409).
- `breakfastIncluded` chưa tác động vào ghi chú PMS (§12).
- `MANUAL` / `OTHER` đã có trong enum nguồn để mở rộng về sau, nhưng giao diện
  hiện chỉ thêm được Booking.com và Agoda.
- Ràng buộc “một tên → một chi nhánh đang bật” do tầng service bảo đảm (SQLite
  không có partial unique index); database chỉ chặn trùng trong cùng một
  chi nhánh + nguồn.

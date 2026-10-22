# Hạng phòng theo chi nhánh (branch room classes)

Phase C.3.8. Mỗi chi nhánh có **danh sách hạng phòng và mã PMS riêng**. Hệ thống
luôn xác định mã phòng theo **chi nhánh của chính đơn đó** — không bao giờ dùng
một bảng mã dùng chung cho tất cả chi nhánh.

Trang: **Khách sạn & chi nhánh → Hạng phòng** (chỉ Admin).

---

## 1. Nguyên tắc bất di bất dịch

1. **Không có bảng mã toàn cục.** Cấu hình nằm trong cơ sở dữ liệu, theo chi nhánh.
2. **Không tra chéo chi nhánh.** Tên phòng chỉ được đối chiếu với cấu hình đang áp
   dụng của chi nhánh thuộc đơn. Không có "mượn tạm" chi nhánh khác.
3. **Không đoán.** Tên không khớp ⇒ trạng thái *chưa xác định*, giữ nguyên
   nguyên văn để người có thẩm quyền chọn tay. Không tự rơi về Standard, không
   lấy hạng phòng đầu tiên.
4. **Đơn cũ không bao giờ bị viết lại.** Mỗi phòng lưu một **ảnh chụp bất biến**
   (snapshot) của hạng phòng tại thời điểm tạo.
5. **Cập nhật qua bản nháp.** Admin không sửa trực tiếp cấu hình đang chạy.

---

## 2. 48 hạng phòng đã xác nhận

Khoá kỹ thuật là **`Branch.code`**. Số CN chỉ là nhãn nghiệp vụ và Admin có thể
đổi bất cứ lúc nào mà không ảnh hưởng gì tới bảng dưới đây.

| CN | Branch.code | Địa chỉ | Số hạng phòng |
| --- | --- | --- | --- |
| CN1 | `TRUONG_DINH_05` | 05 Trương Định | 3 |
| CN2 | `LY_TU_TRONG_260` | 260 Lý Tự Trọng | 8 |
| CN3 | `NGUYEN_TRAI_47A` | 47A Nguyễn Trãi | 4 |
| CN4 | `NGUYEN_THAI_BINH_170` | 170-172-174 Nguyễn Thái Bình | 6 |
| CN5 | `LE_THANH_TON_278` | 278 Lê Thánh Tôn | 6 |
| CN6 | `BUI_THI_XUAN_40` | 40-42 Bùi Thị Xuân | 9 |
| CN7 | `BUI_THI_XUAN_13` | 13 Bùi Thị Xuân | 6 |
| CN8 | `LE_THANH_TON_191` | 191 Lê Thánh Tôn | 6 |
| | | **Tổng** | **48** |

### CN1 — `TRUONG_DINH_05`
| Hạng phòng | Mã PMS |
| --- | --- |
| Standard | `STAN` |
| Superior | `SUP` |
| FamilyTwin | `DEFAM` |

### CN2 — `LY_TU_TRONG_260`
| Hạng phòng | Mã PMS |
| --- | --- |
| Standard | `STAN` |
| Superior | `SUP` |
| Deluxe | `DEL` |
| Premium | `LUXDEL` |
| D-D Room | `DD` |
| Pre-DD | `PRE_DD` |
| Family | `FAM` |
| De-Family | `DEFAM` |

### CN3 — `NGUYEN_TRAI_47A`
| Hạng phòng | Mã PMS |
| --- | --- |
| Standard | `STAN` |
| Superior | `SUP` |
| Deluxe | `DEL` |
| De-Family | `DEFAM` |

### CN4 — `NGUYEN_THAI_BINH_170`
| Hạng phòng | Mã PMS |
| --- | --- |
| Superior | `SUP` |
| Deluxe1&2 | `DEL12` |
| Deluxe3&4 | `DEL34` |
| Deluxe D-D | `DD` |
| Deluxe-Bal | `DEBAL` |
| Suite-Bal | `SUITEBAL` |

### CN5 — `LE_THANH_TON_278`
| Hạng phòng | Mã PMS |
| --- | --- |
| Standard | `STAN` |
| Superior | `SUP` |
| TWIN | `TWIN` |
| Deluxe | `DEL` |
| Studio | `STU` |
| Suite | `SUITE` |

### CN6 — `BUI_THI_XUAN_40`
| Hạng phòng | Mã PMS |
| --- | --- |
| Standard | `STAN` |
| Superior | `SUP` |
| Deluxe | `DEL` |
| DeluxeQueen | `DELQUEEN` |
| Deluxe-Bal | `DEBAL` |
| D-D | `DD` |
| King | `KING` |
| Family | `FAM` |
| De-Family | `DEFAM` |

### CN7 — `BUI_THI_XUAN_13`
| Hạng phòng | Mã PMS |
| --- | --- |
| Standard | `STAN` |
| Superior | `SUP` |
| Deluxe | `DEL` |
| Deluxe-Bal | `DEBAL` |
| King | `KING` |
| Suite | `SUITE` |

### CN8 — `LE_THANH_TON_191`
| Hạng phòng | Mã PMS |
| --- | --- |
| Standard | `STAN` |
| Superior | `SUP` |
| Deluxe | `DEL` |
| King | `KING` |
| Deluxe-Bal | `DEBAL` |
| King Bal | `KINGBAL` |

---

## 3. Chính tả "Superrior" / "Superior"

Nghiệp vụ ghi **Superrior**. Toàn bộ ứng dụng, dữ liệu và bảng parser sẵn có
dùng **Superior**. Quyết định:

- Tên hiển thị chuẩn: **Superior** (một hạng phòng duy nhất mỗi chi nhánh).
- **Superrior** được giữ làm **tên gọi khác (alias)** được nhận diện.
- Mã PMS: **`SUP`** trong mọi trường hợp.

`Superior`, `Superrior`, `SUPERIOR`, `superior`, `superrior` đều ra `SUP`.

---

## 4. Chuẩn hoá và tên gọi khác

Khoá đối chiếu = bỏ dấu → chữ thường → **bỏ mọi ký tự không phải chữ/số**:

```
"Deluxe1&2" · "Deluxe 1&2" · "Deluxe 1 & 2"  → deluxe12
"D-D Room"  · "D D Room"   · "DD Room"       → ddroom
"De-Family" · "De Family"  · "DEFAMILY"      → defamily
"King Bal"  · "King-Bal"                     → kingbal
```

Đối chiếu là **chính xác tuyệt đối trên khoá này — không có fuzzy matching.**
Đó là quyết định an toàn: danh mục chứa những cặp mà bất kỳ thuật toán "gần
đúng" nào cũng có thể nhầm, và nhầm nghĩa là xếp khách sai loại phòng.

**Không bao giờ gộp:**

| | |
| --- | --- |
| `Deluxe` | ≠ `Deluxe-Bal` ≠ `Deluxe D-D` |
| `King` | ≠ `King Bal` |
| `Family` | ≠ `De-Family` |
| `Deluxe1&2` | ≠ `Deluxe3&4` |
| `D-D` | ≠ `Pre-DD` |

Trong một chi nhánh, một tên gọi khác chỉ được trỏ tới **một** hạng phòng
(ràng buộc `(versionId, normalizedAlias)` ở tầng cơ sở dữ liệu).

---

## 5. Ảnh chụp lịch sử (snapshot)

Mỗi `BookingRoom` lưu:

| Cột | Ý nghĩa |
| --- | --- |
| `roomClassId`, `roomClassVersionId` | Nguồn gốc, để truy vết |
| `roomClassBranchId` | Chi nhánh tại thời điểm chốt |
| `roomClassDisplayName`, `roomClassPmsCode` | **Bản sao nguyên văn** — không join lúc đọc |
| `roomClassSourceText` | Nguyên văn tên phòng nguồn |
| `roomClassStatus` | `RESOLVED` / `MANUAL` / `UNRESOLVED` / `LEGACY` |
| `roomClassResolvedAt` | Thời điểm chốt |

Ví dụ: đơn tạo hôm nay với **CN2 / Premium / LUXDEL** sẽ **mãi mãi** hiển thị
Premium / LUXDEL, kể cả sau khi Admin đổi Premium sang mã khác.

**Quy tắc ghi đè:**

- `RESOLVED` / `MANUAL`: **không bao giờ** bị ghi đè tự động.
- `UNRESOLVED` / `LEGACY`: được **điền bổ sung** khi chi nhánh đã xác định
  (ví dụ lúc gửi đơn). Đây là điền chỗ trống, không phải viết lại lịch sử.
- Thay ảnh chụp đã `RESOLVED` chỉ qua thao tác **áp dụng lại** (§8).

---

## 6. Quy trình cập nhật an toàn

```
Cấu hình đang chạy (ACTIVE)  ──────────────▶ lễ tân vẫn dùng bình thường
        │  Tạo bản cập nhật
        ▼
     Bản nháp (DRAFT) ── sửa thoải mái ──▶ Kiểm tra ──▶ Xem thay đổi
        │                                                    │
        │                          Kích hoạt (1 transaction) │
        ▼                                                    ▼
   ACTIVE cũ → ARCHIVED                          DRAFT → ACTIVE
```

- **Lưu nháp** không ảnh hưởng gì tới vận hành, đơn hiện có, hay lễ tân.
- **Kích hoạt** nằm trong **một transaction**. Nếu lỗi ⇒ rollback, phiên bản cũ
  vẫn ACTIVE. Không bao giờ có lúc chi nhánh không có cấu hình, có hai cấu hình
  đang chạy, hay cấu hình cập nhật dở.
- Chỉ số **partial unique index**
  `BranchRoomMappingVersion_one_active_per_branch` khiến "hai ACTIVE" là bất khả
  thi ở tầng cơ sở dữ liệu, kể cả khi hai Admin bấm cùng lúc.
- **Chống ghi đè lẫn nhau:** khi kích hoạt, client gửi kèm phiên bản ACTIVE mà
  họ đã xem. Nếu người khác đã kích hoạt trong lúc đó ⇒ **409**, không âm thầm
  đè lên thay đổi của họ.

### Hộp thoại xác nhận nói rõ

> - Đơn đã tạo sẽ **giữ nguyên mã phòng cũ**.
> - Chỉ đơn tạo mới sau khi kích hoạt mới dùng cấu hình mới.
> - Ghi chú đã tạo trước đó **không bị viết lại**.

---

## 7. Kiểm tra hợp lệ

Từ chối: tên rỗng · mã PMS rỗng · trùng tên chuẩn hoá · trùng mã PMS (trong các
hạng đang bật) · alias rỗng · alias trỏ hai hạng phòng · kích hoạt cấu hình
rỗng · kích hoạt bản nháp không hợp lệ · kích hoạt bản nháp cũ · sửa phiên bản
ACTIVE/ARCHIVED · dùng bản nháp của chi nhánh khác.

Mã PMS được chuẩn hoá về dạng IN HOA với `_`: `pre dd` / `pre-dd` → `PRE_DD`.
18 mã đã xác nhận được giữ **nguyên văn**: `STAN SUP DEFAM DEL LUXDEL DD PRE_DD
FAM DEL12 DEL34 DEBAL SUITEBAL TWIN STU SUITE DELQUEEN KING KINGBAL`.

---

## 8. Áp dụng lại cấu hình cho một đơn

**Không bao giờ tự động.** Yêu cầu: quyền Admin · lý do bắt buộc · xem trước
giá trị cũ và mới · ghi audit · đơn chưa `COMPLETED`/`ARCHIVED`.

```
GET  /api/bookings/:id/room-mapping/preview        # chỉ xem, không đổi gì
POST /api/bookings/:id/room-mapping/apply-latest   # { reason }
```

Nếu tên phòng không giải được theo cấu hình mới, ảnh chụp cũ **được giữ nguyên**
— không bao giờ xoá trắng mã mà đơn đang có.

---

## 9. Khách (guest) trong đơn

Ngữ nghĩa **PATCH**: chỉ trường thực sự gửi lên mới bị ghi.

- `{ phone: "090…" }` ⇒ chỉ đổi số điện thoại. Tên, hộ chiếu, quốc tịch, email,
  ghi chú, các khách khác, hạng phòng, mã phòng, thanh toán, tệp đính kèm,
  trạng thái, ngày ở… **giữ nguyên**.
- `{ phone: null }` ⇒ xoá số điện thoại (gửi khoá một cách tường minh).
- Gửi khoá lạ (ví dụ `phoneNumber`) ⇒ **422**, không âm thầm bỏ qua.
- `Booking.customerName` / `Booking.phone` vẫn là **bản sao của khách chính**,
  được đồng bộ trong cùng transaction ⇒ mọi màn hình, ghi chú, export cũ chạy
  y như trước.
- Khách chính không xoá được khi còn khách khác — hãy đặt khách chính mới trước.
- **Chống mất thay đổi:** gửi kèm `expectedUpdatedAt`; nếu người khác vừa sửa ⇒ **409**.

**Sửa khách không bao giờ đổi chi nhánh, hạng phòng hay mã phòng.** Đó là thao
tác vận hành riêng biệt.

---

## 10. Phân quyền

| Thao tác | Ai được làm |
| --- | --- |
| Xem / tạo / sửa / kiểm tra / kích hoạt cấu hình hạng phòng | **Admin** |
| Áp dụng lại cấu hình cho một đơn | **Admin** |
| Xem / thêm / sửa khách | Admin, hoặc lễ tân **của đúng chi nhánh** và đơn **đã gửi xuống** |

Toàn bộ được chặn ở **backend**. Ẩn nút ở giao diện không phải là biện pháp bảo vệ.

---

## 11. Nhật ký (audit)

Cấu hình hạng phòng dùng chung `BranchChangeLog` với quản lý chi nhánh:
`ROOM_MAPPING_DRAFT_CREATED` · `ROOM_MAPPING_DRAFT_CANCELLED` ·
`ROOM_CLASS_ADDED` · `ROOM_CLASS_UPDATED` · `ROOM_CLASS_DEACTIVATED` ·
`ROOM_CLASS_REORDERED` · `ROOM_CLASS_ALIAS_ADDED` · `ROOM_CLASS_ALIAS_REMOVED` ·
`ROOM_MAPPING_VALIDATED` · `ROOM_MAPPING_ACTIVATED` ·
`ROOM_MAPPING_ACTIVATION_FAILED`.

Sự kiện theo đơn dùng `BookingAuditEvent`: `BOOKING_GUEST_ADDED` ·
`BOOKING_GUEST_UPDATED` · `BOOKING_GUEST_REMOVED` ·
`BOOKING_PRIMARY_GUEST_CHANGED` · `BOOKING_ROOM_MAPPING_REAPPLIED`.

Mỗi bản ghi có: người thực hiện, vai trò, giá trị cũ/mới, lý do, thời điểm.

---

## 12. Migration và dữ liệu cũ

Migration `20260728093914_c38_branch_room_class_versioning` là **cộng thêm hoàn
toàn**: chỉ tạo bảng và cột nullable rồi điền vào. Không xoá, không định nghĩa
lại bảng nào.

**Sao lưu trước khi migrate** (xem [backup-restore.md](backup-restore.md)):

```bash
./scripts/production/backup.sh
```

Backfill:

1. Mỗi đơn hiện có được tạo **một khách chính** sao chép từ
   `customerName` / `phone`. Không bịa: tên rỗng vẫn là tên rỗng.
2. Mỗi phòng hiện có được ghi `roomClassSourceText` = tên phòng cũ và đánh dấu
   **`LEGACY`**. **Cố ý KHÔNG suy ra mã PMS**: mã cũ đến từ bảng toàn cục không
   biết chi nhánh, nên đoán một mã theo chi nhánh cho dữ liệu lịch sử chính là
   kiểu viết lại âm thầm mà phase này sinh ra để ngăn chặn.

Dòng `LEGACY` tiếp tục hiển thị qua **đường dẫn viết tắt cũ** (`abbreviateRoomType`)
nên ghi chú của đơn cũ **không đổi một ký tự nào**. Khi cần, Admin giải quyết
từng đơn bằng thao tác áp dụng lại (§8).

Seed production **idempotent**: chi nhánh nào đã có cấu hình sẽ được **bỏ qua
hoàn toàn** — chạy lại không tạo trùng, không hồi sinh hạng phòng đã tắt, không
đánh lại số phiên bản.

---

## 13. Hướng dẫn cho quản trị viên

1. **Tạo bản nháp** — *Khách sạn & chi nhánh* → dòng chi nhánh → **Hạng phòng** →
   **Tạo bản cập nhật**. Hệ thống sao chép cấu hình đang chạy.
2. **Thêm hạng phòng** — nhập Tên hạng phòng + Mã PMS → **Thêm hạng phòng**.
3. **Sửa mã PMS** — gõ vào ô mã của hạng phòng rồi rời khỏi ô (blur) để lưu.
4. **Thêm tên gọi khác** — gõ vào ô *Thêm tên gọi khác* rồi nhấn Enter.
5. **Kiểm tra** — bấm **Kiểm tra**. Mọi lỗi hiện thành danh sách đọc được.
6. **Kích hoạt** — bấm **Kích hoạt cập nhật**, đọc bảng tóm tắt thay đổi và
   cảnh báo, nhập lý do (tuỳ chọn), xác nhận.
7. **Vì sao đơn cũ không đổi** — mỗi đơn giữ ảnh chụp riêng (§5). Chỉ đơn tạo
   mới mới dùng cấu hình mới.
8. **Thêm / sửa khách** — trong chi tiết đơn; chỉ trường bạn sửa mới thay đổi (§9).
9. **Xem nhật ký** — lịch sử phiên bản ngay trong hộp thoại Hạng phòng; nhật ký
   theo đơn ở `GET /api/bookings/:id/audit`.
10. **Huỷ bản nháp** — bấm **Huỷ bản nháp**. Cấu hình đang chạy không hề bị chạm.

---

## 14. Giới hạn đã biết

- **Không có fuzzy matching.** Tên tiếng Việt tự do (ví dụ *"Phòng Deluxe Có
  Giường Cỡ Queen"*) **không** tự khớp. Đây là lựa chọn có chủ đích: CN6 có cả
  *Deluxe* lẫn *DeluxeQueen*, đoán sai là xếp sai loại phòng. Những phòng như
  vậy ở trạng thái chưa xác định và dùng viết tắt cũ cho tới khi có người xử lý.
- **130 phòng của 10 đơn hiện có** đang ở trạng thái `LEGACY` (xem §12).
- Mỗi chi nhánh chỉ mở **một bản nháp** tại một thời điểm.
- Chỉ số partial unique index được tạo trong migration chứ không khai báo trong
  `schema.prisma` (Prisma chưa hỗ trợ). Đừng xoá nó khi sinh migration mới.
- Đổi hạng phòng của một đơn đang chạy vẫn là thao tác riêng, chưa có nút bấm
  trên giao diện — dùng API áp dụng lại (§8).

# قرارداد سازگاری آینده با روال — پیشنهادی، نیازمند G1

## هدف

REVAL اکنون کاملاً مستقل است: کاربران، نشست، دیتابیس، ذخیره فایل، استقرار و گردش وضعیت مستقل. هیچ نیاز به روشن‌بودن روال، import کد داخلی آن یا دسترسی به دیتابیس آن وجود ندارد. سازگاری آینده به معنی نگاشت صریح و API قابل تست است؛ ادغام بدون هزینه تضمین نمی‌شود.

## شواهد بررسی‌شده از روال

مرجع محلی بازبینی‌شده در P01 پوشهٔ `F:/workspace/noora/nooraback` در کامیت `dd8198e391e49610baf7f11f443fa69cd1469c9b` است. فایل‌های مرتبط در زمان بررسی تغییر ثبت‌نشده نداشتند.

- `src/modules/product/schemas/product.schema.ts`: NestJS/Mongoose، Mongo ObjectId برای categoryId، نام محصول، stock شامل quantity/startIndex/endIndex/counter و alertThreshold؛ خروجی id مجازی و حذف _id.
- `src/modules/branch/schemas/branch.schema.ts`: name، title، managerId ارجاع به User و isDeleted.
- `src/modules/users/schemas/user.schema.ts`، `src/modules/user-groups/schemas/user-group.schema.ts` و `src/modules/permissions/schemas/permission.schema.ts`: هویت کاربر، عضویت گروه، نوع گروه، و مجوزهای مبتنی بر اقدام، موضوع و شرط.
- `src/common/providers/custom-response.service.ts` و `src/common/interceptors/response.interceptors.ts`: پاسخ معمول با statusCode، message، result.
- `src/shared/crud/dto/get-query.dto.ts` و controller محصول: صفحه‌بندی page/size از صفر، فهرست دارای data/count.
- `src/modules/product/product.controller.ts`: الگوی CheckPermissions با action/subject.

این بررسی مبنای نسخهٔ محلی بالا را مشخص می‌کند. تطبیق با محیط نصب‌شدهٔ روال و اجرای تست قرارداد روی آن به بررسی بعدی وابسته است.

### نگاشت اولیه

| روال | نگاشت پیشنهادی REVAL |
|---|---|
| شناسه و `isActive` کاربر | ثبت شناسهٔ خارجی در `externalRefs` و نگاشت وضعیت فعال. نام کاربری اختیاری روال، در صورت نبودن، در فرایند ساخت حساب REVAL تعیین می‌شود. |
| `User.groups` و `UserGroup.type` | گروه از نوع `role` به نقش و گروه‌های سازمانی به محدوده‌های صریح نگاشت می‌شوند. نگاشت به‌تنهایی مجوزی ایجاد نمی‌کند. |
| `User.branchId` و مدل `Branch` | در این کامیت، `User.branchId` به `UserGroup` ارجاع دارد. شناسهٔ گروه شعبه و شناسهٔ مدل Branch باید با نگاشت صریح تطبیق داده شوند. |
| `Permission.actions/subject/conditions` | فقط اقدام‌ها، موضوع‌ها و شرط‌های شناخته‌شده به مجوز و محدودهٔ REVAL نگاشت می‌شوند. موارد ناشناخته برای بازبینی ثبت می‌شوند. |
| `Product/Category` | نگاشت جداگانه برای مدل محصول و SKU. مقدار `stock` روال برای تطبیق یا گزارش در نظر گرفته می‌شود و منبع ثبت گردش REVAL نیست. |

## پیشنهاد فنی برای استقلال همراه سازگاری

- بک‌اند: Express + Mongoose روی Node.js LTS. فرانت‌اند: React + React Router + Vite. زبان هر دو JavaScript است و ظاهر از HTML مرجع می‌آید. جزئیات در [تصمیم معماری](docs/P01/ADR-001-STACK.md) ثبت شده‌اند.
- دیتابیس مستقل MongoDB با replica set برای تراکنش‌های چندسندی. Redis تنها در صورت نیاز روشن به صف/قفل/محدودسازی؛ موجودی مرجع در Redis نباشد. در شروع نیازی به microservice یا موتور BPMN جدا نیست.
- بک‌اند یکپارچهٔ ماژولار است. هر ماژول مرز مشخص برای مسیر، کنترلر، اعتبارسنجی، سرویس دامنه و دسترسی به مدل دارد. تغییر دادهٔ ماژول دیگر از طریق سرویس دامنهٔ آن انجام می‌شود.
- collectionهای تخصصی با نام مشخص `reval_*`؛ کاربران و شعب نیز فعلاً در دیتابیس مستقل. در ادغام، تطبیق شناسه با mapping انجام شود؛ صرف برابری نام یا شماره سند، دلیل یکی‌بودن موجودیت نیست.
- شناسه داخلی Mongo ObjectId، نمایش API به شکل id رشته‌ای. کد خوانا مثل DLV/REQ و IMEI شناسه داخلی نیستند. کد سند immutable و با شمارنده اتمیک ساخته شود.
- روابط با فیلدهای userId، branchId، productId و مانند آن؛ ورودی API شناسه را اعتبارسنجی کند. aliasهای خارجی در externalRefs شامل system/entity/id ذخیره شوند.
- organizationId پیشنهادی برای مرزبندی داده؛ branchId برای شعبه، lineId و stationId برای عملیات. تک‌سازمانی با یک organization پیش‌فرض کافی است؛ چندسازمانی واقعی فقط با تصمیم دامنه. محدودسازی سمت سرور لازم است.
- createdAt/updatedAt به UTC، createdBy/updatedBy با شناسه کاربر، version صریح برای کنترل رقابت. تاریخ شمسی فقط نمایش؛ مقدار ذخیره‌شده ISO/UTC. مقدار تعداد صحیح برای قطعه و نوع عدد دقیق برای واحدهای کسری؛ تصمیم واحدها در G0.
- نمونه پاسخ: `{statusCode:200,message:"...",result:{data:[],count:0}}`؛ صفحه‌بندی page=0,size=10 با حداکثر محدود. خطا HTTP صحیح و کد خطای ثابت داشته باشد؛ الگوی پاسخ روال به معنی برگرداندن HTTP 200 برای همه خطاها نیست.
- endpointها زیر `/api/v1`؛ OpenAPI و تست قرارداد. فیلتر، sort، projection و populate تنها allowlist؛ query خام Mongo از کلاینت پذیرفته نشود.
- واژگان مجوز نمونه HTML (view/create/edit/approve/reject/scan/transfer/report/pdf/settings/users) حفظ و به action/subject نگاشت شود. کنترل line/station/warehouse علاوه بر نقش. تبدیل edit→update و view→read در adapter مستند شود، نه با تغییر معنای نقش‌ها.
- رویدادهای داخلی نسخه‌دار: ShipmentReceived، MaterialDeliveryIssued/Received، ProductionStarted، QualityRejected/Passed، FinishedGoodsStored. eventId، schemaVersion، occurredAt، actorId، organizationId، aggregateId/version و correlationId. outbox تراکنشی وقتی side effect یا انتشار لازم است؛ consumer تکرارپذیر.
- در آینده adapter برای کاربران، شعب، کارتابل و رخدادها اضافه می‌شود. فعلاً هیچ درخواست شبکه به روال و هیچ تبادل رمز/نشست با آن وجود ندارد.

## مدل دامنه پیشنهادی

User/Role/PermissionScope، Organization/Branch؛ Supplier؛ PartType/SKU/Unit؛ ProductModel/Color؛ BOMVersion/BOMItem؛ Line/Station/RoutingVersion؛ Warehouse/Location؛ Shipment/Pallet/MaterialCarton؛ StockLedger/StockBalance/Reservation؛ MaterialRequest/Delivery/ReceiptDiscrepancy؛ ProductionOrder؛ IMEIRecord/IMEIBatch؛ PhoneUnit؛ Basket/BasketItem؛ SerializedPart/Installation؛ StationVisit؛ TestDefinition/TestResult؛ Defect/Replacement/Rework؛ ReturnDocument؛ PackagingUnit/MasterCarton؛ FileAsset/AuditEvent/IdempotencyRecord/OutboxEvent. Dealer/DistributionOrder فقط پس از تعیین تکلیف D01.

برای هر entity در P01 فیلد، نوع، required/default، روابط، index/unique scope، وضعیت‌ها، سیاست حذف و مثال JSON نوشته شود. این فهرست جای schema اجرایی کامل نیست.

## مرز با مدل Product روال

مدل فعلی روال دفتر گردش تولید نیست. مقدار stock آن را به‌عنوان دفتر موجودی REVAL استفاده نکنید. ProductModel/SKU در REVAL مدل تخصصی مستقل داشته باشند و در آینده به Product/Category روال نگاشت شوند. هویت ProductModel با قطعه SKU و واحد فیزیکی PhoneUnit متفاوت است.

## قواعد غیرقابل چشم‌پوشی

- حرکت موجودی فقط با سند و ledger ثبت‌شده؛ مانده مستقیم از UI ویرایش نشود. اصلاح با سند جبرانی، علت و مجوز است؛ تاریخچه حذف نشود.
- صدور/دریافت/مصرف/تعویض و تغییر state مرتبط یک تراکنش باشند؛ شکست نیمه‌راه نباید مانده ناقص بسازد.
- رزرو از موجودی قابل مصرف کم می‌کند؛ انتقال مواد به خط به معنی مصرف نیست. تعریف دقیق physical/available/reserved/transit/line/quarantine و آشتی موجودی در G1 تصویب شود.
- idempotency key برای فرمان‌های دارای اثر، کنترل unique و version؛ دو اپراتور روی آخرین قطعه: فقط یک موفقیت. retry با payload متفاوت و همان key رد شود.
- IMEI و سریال تکراری با index یکتا در دامنه مصوب رد شود؛ IMEI رشته است، نه Number. IMEI1/IMEI2 و قاعده یکتایی بین slotها در G0 تصمیم‌گیری شود.
- BOM و مسیر تولید نسخه‌دار؛ سفارش و واحد تولید snapshot/reference نسخه قفل‌شده داشته باشند تا تغییر اطلاعات پایه تاریخچه محصول را تغییر ندهد.
- محدودیت‌ها و مجوزها در API؛ sessionStorage/localStorage مرجع هویت یا موجودی نباشند. localStorage فقط ترجیح ظاهری غیرحساس.
- پیشبرد وضعیت تنها با command مجاز، نه PATCH عمومی status. بازگشت/اصلاح قواعد جدا دارد. UI و آینده BPMN هر دو از همان command استفاده می‌کنند.

## تست ادغام‌پذیری قبل از تحویل

fixture قرارداد پاسخ، ObjectId/id، pagination، mapping نقش‌ها، mapping Product/SKU، round-trip externalRefs، رویداد نسخه‌دار و سناریوی دریافت تکراری رویداد اجرا شود. مثال adapter محلی بدون اتصال زنده روال ارائه شود. نتیجه «سازگاری با قرارداد نسخه X» است نه «ادغام تضمینی با هر نسخه روال».

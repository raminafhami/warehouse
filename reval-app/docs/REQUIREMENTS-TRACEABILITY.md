# ردیابی تغییرات مرحله تطبیق رابط

فهرست کامل الزامات در `reval/TRACEABILITY.csv` و جزئیات تعاملات در `reval/docs/P00/UI-INVENTORY.md` ثبت شده‌اند. جدول زیر فقط تغییرات این مرحله را به API و شاهد مرتبط وصل می‌کند.

| محدوده | پیاده‌سازی و API | شاهد |
|---|---|---|
| پوسته و ورود | `AppShell` و `AccessPage`، نشست و ورود واقعی و `/demo/accounts` | ورود با حساب نمایشی، نمایش رمز، نوار ناوبری و Drawer در Chrome |
| داشبورد و گزارش | `DashboardPage` و `ReportsPage` با `/dashboard` و `/reports/overview` | تصاویر سه اندازه، آزمون داده یکپارچگی و پیش‌نمایش گزارش |
| ورودی و انبار | `ShipmentsPage`، `InventoryPage` و `HandoverPage` با API محموله، موجودی و حواله | سناریوی محموله سالم و دارای مغایرت، جانمایی و تحویل واقعی به خط |
| تولید | `ImeiPage`، `BasketPage` و `AssemblyPage` با تخصیص، فیلتر خط و دریافت سبد | سناریوی seed، محدوده حساب ایستگاهی و عکس مسیرها |
| کیفیت و محصول | `StageQcPage`، `FinalQualityPage`، `DefectsPage` و `FinishedPage` با صف‌ها، رخدادها و کارتن | نتیجه قبول و رد، مرجوعی، بسته‌بندی و کارتن جانمایی‌شده |
| رهگیری و مدیریت | `TracePage`، `MasterPage`، `UsersPage` و `AuditPage` | جست‌وجوی CTN-1405-8101، BOM و آزمون رد دسترسی ایستگاه به کاربران |

هر ردیف در [ماتریس تطبیق](UI-PARITY-MATRIX.md) به نمای اصلی و اختلاف‌های باز مرتبط است.

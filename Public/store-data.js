/* داده‌های فروشگاه IMRC
   هر محصول رو اینجا اضافه یا ویرایش کن. فیلدها:
   id: شناسه‌ی یکتا
   type: "panel" (پنل ساخت کانفیگ) یا "gaming" (سایت گیمینگ)
   link: آدرس «مشاهده». خالی بذار اگه لینک نداری.
   price: { fa, en } متن قیمت. خالی بذار تا نمایش داده نشه.
   fa / en: { title, desc } عنوان و توضیح به هر زبان
   tags: برچسب‌های کوتاه
*/
window.STORE_CONTACT = "https://t.me/IMRC_Panel";

window.STORE_PRODUCTS = [
  {
    id: "imrc-panel",
    type: "panel",
    link: "/",
    price: { fa: "طبق پلن‌های ربات", en: "Per bot plan" },
    fa: {
      title: "پنل ساخت کانفیگ IMRC",
      desc: "ساخت کانفیگ با انتخاب کشور، حالت بازی، نقش، DNS و MTU. ورود با تلگرام و سهمیه‌بندی.",
    },
    en: {
      title: "IMRC Config Builder",
      desc: "Build configs by country, mode, role, DNS and MTU. Telegram login and quotas.",
    },
    tags: ["Telegram", "Quota"],
  },
  {
    id: "sample-gaming-1",
    type: "gaming",
    link: "",
    price: { fa: "", en: "" },
    fa: {
      title: "سایت گیمینگ (نمونه)",
      desc: "این کارت نمونه است. با محصول واقعی‌ات جایگزینش کن.",
    },
    en: {
      title: "Gaming site (sample)",
      desc: "This is a sample card. Replace it with your real product.",
    },
    tags: [],
  },
];

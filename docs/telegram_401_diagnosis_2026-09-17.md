# تشخيص: خطأ "حصلت مشكلة في معالجة طلبك" على تليجرام

**التاريخ:** 2026-09-17 · **الحالة:** السبب الجذري مؤكَّد · **الإصلاح:** تعديل اعتماد واحد في n8n

---

## 1. السبب الجذري (مؤكَّد من سجلات التنفيذ)

مخرج نود **`Call Core Engine`** في workflow `Telegram Reply Nodes`:

```
401 - {"detail":"unauthorized"}
```

الـ core-engine بيرفض الطلب قبل ما يقرأ الرسالة أصلاً. ونود `Prepare Telegram Reply`
بيقرا `reply_text` من الرد، فلما الرد يبقى خطأ 401 مفيش `reply_text` — فيسقط على
النص الثابت:

```js
if (!replyText || String(replyText).trim() === '')
  replyText = 'عذراً، حصلت مشكلة في معالجة طلبك. حاول مرة أخرى.';
```

**يعني رسالة الخطأ دي مش من النظام بتاعنا — دي شبكة أمان في n8n بتخفي فشل 401.**

### ليه 401؟

`app/core/security.py`:

```python
if not hmac.compare_digest(x_k2_internal_token, settings.K2_INTERNAL_TOKEN):
    raise HTTPException(status_code=401, detail="unauthorized")
```

- التوكن المنشور على Railway **مطابق** لـ `.env` المحلي (تم التحقق: 35 حرفًا، متطابقان).
- الاعتماد في n8n (`K2 Internal Core Engine Auth`) فيه **القيمة القديمة**.

**والتوثيق بيأكد ده** — `MIGRATION_STATUS.md:87`:

> `K2_INTERNAL_TOKEN`: regenerated (**old value unknown**); value stored in .env only —
> the WhatsApp sender must send this header value at cutover (or the old value recovered
> from the sender's env can be used instead — **one of the two must match**).

التوكن اتجدّد وقت الترحيل، والخطوة دي **ما اتنفذتش** في n8n.

**مش بسبب أي شغل حصل النهاردة:** الخطأ موجود في تنفيذات الساعة 11:42 و13:06،
قبل أول نشر في اليوم.

---

## 2. حجم المشكلة: كل القنوات، مش تليجرام بس

الاعتماد `K2 Internal Core Engine Auth` (`xPxPLp6347kB67XL`) **مشترك** بين 11 workflow:

| Workflow | النود |
|---|---|
| Telegram Reply Nodes | `Call Core Engine` |
| WhatsApp Production - Gupshup | `Call Core Engine GUPSHUP` |
| SuperChat Whatsapp - Trial | `Call Core Engine SUPERCHAT` |
| SuperChat Instagram - Trial | `Call Core Engine SUPERCHAT` |
| SuperChat Messenger - Trial | `Call Core Engine SUPERCHAT` |
| Instagram Channel (provider-agnostic) | `Call Core Engine Instagram Thikaa1` |
| K2 Deferred Message Worker | `Call K2 Core For Deferred Batch` |
| MERUNA / Follow-up / One Workflow v1 | `Dashboard Follow-up Intake Webhook` |
| MERUNA / Notifications / 04 - Delivery | `POST /meruna/notifications/delivery` |
| MERUNA / No-show & Recovery / 07 | `Recovery rebooking webhook` |
| MERUNA / No-show & Recovery / 08 | `Recovery outcome webhook` |

**يعني كل قنوات المرضى مكسورة حاليًا** — واتساب وإنستجرام وماسنجر وتليجرام.

---

## 3. الإصلاح

### الطريقة الصحيحة (موصى بها)

**حدّث اعتماد واحد في n8n:**

1. افتح n8n → **Credentials** → `K2 Internal Core Engine Auth`
2. الحقل **Name**: `X-K2-Internal-Token`
3. الحقل **Value**: القيمة الموجودة في `.env` عندك تحت `K2_INTERNAL_TOKEN`
   (نفس القيمة المنشورة على Railway — الطول 35 حرفًا، تبدأ بـ `k2-`)
4. احفظ

بعد الحفظ، كل الـ 11 workflow هيشتغلوا فورًا من غير أي نشر أو تعديل تاني.

**مهم:** استخدم القيمة من `.env` مش أي قيمة تكتبها — لازم تطابق المنشور على Railway بالحرف.

### التحقق بعد الإصلاح

```bash
python tools/test_live_endpoint.py      # يتأكد إن التوكن مقبول
```

ثم ابعت رسالة من تليجرام — المفروض ترد طبيعي.

---

## 4. البديل (لو مش قادر تدخل واجهة n8n)

ممكن أعدّل الـ workflows نفسها تبعت الهيدر مباشرة بدل الاعتماد — بس ده **تنزيل في الأمان**:
التوكن هيبقى مقروء في JSON الـ workflow لأي حد عنده صلاحية قراءة، بدل ما يبقى في
اعتماد مشفّر. لو ده مقبول عندك قوللي وأعملها.

---

## 5. ملاحظة جانبية مهمة

خطأ 401 بيتحوّل لرسالة عربية ودّية "حاول مرة أخرى" — يعني **فشل المصادقة بيبان للمريض
كأنه عطل مؤقت**. ده بيخلي المشاكل دي تختفي بصمت. يستحق تحسين: لو الرد 401/403،
الـ workflow المفروض يسجّلها كخطأ تشغيلي (والـ K2 Error Monitor يبلغ) بدل ما يبعت
رسالة عامة للمريض.

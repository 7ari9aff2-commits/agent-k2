# تقرير الفحص العميق — agent k2

**التاريخ:** 2026-09-17 · **الكوميتات:** `b6673dc` (التنظيف) + `746013a` (إزالة ملف مؤقت)
**المعيار:** لا شيء ثابت يشكّل أو يستبدل رد النموذج · لا كود ميت بجانب كود حي

**الطريقة:** مسح كل النصوص العربية في `app/` سطرًا بسطر · تتبّع كل مسار يمكن أن يصل للمريض
· تحليل مرجعي لكل دالة/ثابت/مفتاح إعداد · التحقق اليدوي من كل ادعاء · ثم اختبار على الإنتاج.

---

## 1. أخطر ما وُجد: ردود ثابتة كانت تطغى على النموذج

### 1.1 `reply_guard` كان يكتب ردًا جاهزًا لكل حالة نهائية

`app/core/reply_guard.py` كان يولّد جملة عربية مكتوبة مسبقًا لكل رمز استجابة
(`APPOINTMENT_CREATED`, `CANCEL_COMPLETED`, `RESCHEDULE_COMPLETED`, `IDEMPOTENT_REPLAY`,
`CONFIRMATION_EXPIRED`, `AVAILABILITY_SOURCE_ERROR`, `confirm_without_target`) ويكتبها في
`agent_reply` و`_reply_guard.override`.

**وموضعها كان فوق رد النموذج.** في `message.py` كانت سلسلة السقوط:
`guard_override` ← `policy.agent_reply` ← … يعني لو فشل المؤلف (شبكة/مفتاح/حد معدل)،
المريض يستلم قالبًا جامدًا بدل كلام النموذج.

**الإصلاح:** `reply_guard` بقى كشف فقط — `override` دايمًا `None`، والبيانات الوصفية
(`triggered`/`rule`/`code`) باقية للتدقيق. 249 → 187 سطرًا.

### 1.2 ترتيب الأسبقية كان يقدّم القالب

`app/pipeline/respond.py` كان: `reply_text = override if override else rendered_reply`.
**الإصلاح:** `rendered_reply` (كلام النموذج) الأول. و`_debug.deterministic_override`
بقى `True` فقط لما الـ override يكون هو النص المُرسل فعلاً.

### 1.3 سلسلة السقوط في `message.py`

كانت: `guard_override` ← `policy.agent_reply` ← …
**الإصلاح:** كل مرشّحي النموذج أولاً، وأخيرًا **إشعار عطل تقني واحد** فقط
(`_MODEL_UNAVAILABLE_REPLY`) — وهو ليس ردًا بل إشعار بأن كل نداءات النموذج فشلت.

### 1.4 `agent_output` كان يعيد كتابة جملة النموذج

`_claim_sanitize` كان يستبدل أول ادعاء بالكلمة الثابتة `'تمام'`:
```python
return m.group(0) if _NEGATION_BEFORE_RE.search(before) else 'تمام'
```
ده بالحرف "تصحيح كلام النموذج" المرفوض.
**الإصلاح:** الكشف باقٍ كتحذير تدقيقي (`reply_claims_unverified_booking`)، والنص ما بيتغيّرش.

### 1.5 جدول ردود كامل داخل `stages_post`

`extract_single_agent_reply` كان جواه `_stage_plan()` — جدول ردود عربية لكل رمز استجابة
(بطاقة حجز، أسئلة جمع بيانات، تأكيد…). الدالة كانت تُستدعى **فقط** من فرع غير قابل للوصول.
**الإصلاح:** حذف الدالة و`prepare_single_agent_result_context` — **882 سطرًا**.

### 1.6 جدول ردود احتياطي في `response_policy`

`fallback_by_code` + `_fallback_*` + `human_labels` + `deterministic_fallback_reply` —
كانت "شبكة أمان" للمؤلف القديم، ومصدرها الوحيد كان الدالة المحذوفة.
**الإصلاح:** حذفها — **182 سطرًا**.

### 1.7 نصوص في `gates.py`

4 جمل عربية مكتوبة مسبقًا في `final_reply`. لا تصل للمريض حاليًا، لكنها قالب جاهز للانفلات.
**الإصلاح:** اتشالت — الأسباب فقط، بلا نص.

---

## 2. أخطر اكتشاف معماري: نظام prompts تاني كامل

`app/pipeline/stages_pre.py` كان يبني **~28,645 حرفًا** من نصوص الـ prompts ثم **يرميها**:

| الثابت | الحجم |
|---|---|
| `_CONFIRM_FAST_TAIL` | 14,823 |
| `_FULL_AGENT_SYSTEM_PROMPT` | 8,594 |
| `_CONFIRM_FAST_HEAD` | 1,028 |
| `_SMALL_TALK_SYSTEM_PROMPT` | 949 |
| `_CLINIC_QUERY_SYSTEM_PROMPT` | 901 |
| `_CTC_*` + `_NATURAL_ARABIC_SUFFIX` + `_TENANT_PERSONA_SUFFIX` + `_BOOKING_STAGE_SAFETY_SUFFIX` | ~2,128 |

بالإضافة إلى بلوك تجميع من 60 سطرًا وسلّم `agent1_max_tokens`.
**المشكلة:** لا شيء يقرأ `agent_system_prompt` — إلا لحساب عدد حروفه للاستهلاك.

يعني كان فيه **نظامان للـ prompt**، الحقيقي ملف واحد (2,798 حرفًا)، والثاني أكبر منه
10 مرات وميت. أي تعديل فيه ما بيأثرش على شيء — وده فخ خطير بالذات لما الهدف
"نربي النموذج من الأول".

**الإصلاح:** حُذف كله. النموذج بقى له prompt واحد فقط:
`app/services/prompts/agent_system_message.txt`.
و`agent_system_prompt_chars` بقى يُقاس من الملف الحقيقي.

---

## 3. الكود الميت المُزال

**وحدات كاملة:**
`app/core/grounding.py` (طبقة تحقق تجاوزها المؤلف — كانت ميتة أصلاً بسبب عيب `render_used`)
· `app/utils/datetime_utils.py` · `app/utils/phone.py` (`patient_fields.py` بيقول صريح إنه
مش منطق النود ده) · `app/schemas/` (فاضي) · `app/services/prompts/agent_prompt.txt`

**دوال:**
`dialogue.call_primary_model` (نسخة قديمة بدون أدوات) · `dialogue.parse_contract_json`
· `security.verify_hmac_signature` · `repository._fetch` · `stages_post._strip_unsupported_doctor_specializations`
· `stages_post._strip_reply_punctuation` · `availability._js_iso_now_ms` · `helpers.is_valid_uuid`
· `stages_pre.route_single_agent_phase` · `conditions_pre.if_single_agent_result_phase`

**مفاتيح إعداد ما حدش بيقرأها:**
`ENVIRONMENT` · `REQUIRE_HMAC` · `HMAC_SECRET` · `LLM_TEMPERATURE` · `LLM_REPAIR_TEMPERATURE`
· `GROUNDING_MODE` · `N8N_BASE_URL`

**اختبارات تغطي كودًا محذوفًا:** `test_grounding.py` · `test_phone_normalization.py`
· `test_single_agent_result_phase_bypass` · حالة `parse_contract_json`

> **ملاحظة صريحة:** عدد الاختبارات نزل من 62 لـ 50. النزول **كله** اختبارات لكود ميت
> كان بيعدّي وهي الميزة معطّلة في الإنتاج — وده اللي خلّى العيوب تعيش.

---

## 4. فروع غير قابلة للوصول

`if_single_agent_result_phase` في `message.py` كانت **دايمًا `False`**:
`route_single_agent_phase` كانت تُنادى بمدخلات فاضية ← `upstream_phase = None`
← `has_execution_evidence = False` ← `loop_count = 1` ← `phase = "understand"` دايمًا.

يعني فرع "الرد الطبيعي" في تصميم n8n الأصلي **ما اشتغلش ولا مرة** في الـ port.
اتشال، ومعاه الدالتان اللي كان بيستدعيهم.

---

## 5. ما لم يُحذف (عن قصد)

| البند | السبب |
|---|---|
| `_SAVE_FAILED_REPLY` في `respond.py` | إشعار عطل بنية تحتية، ليس ردًا. لو فشل حفظ الحالة ما يصحّش إن الرد يبان ناجحًا |
| `_MODEL_UNAVAILABLE_REPLY` في `message.py` | نفس المنطق — يُستخدم فقط لما **كل** مرشّحي النموذج يكونوا فاضيين |
| نصوص `message` في `availability.py` | دي **بيانات نتيجة أداة** توصل كـ facts، مش قوالب رد. النموذج بيقرأها مع الحقول المنظمة ويكتب بنفسه |
| regex التطبيع والتصنيف | ليست ردودًا: تطبيع هاتف/تاريخ/أرقام عربية، تصنيف نية، مطابقة أسماء دكاترة |
| أسماء الأيام والشهور | بيانات تنسيق |

---

## 6. التحقق

**محليًا:** `pytest tests/ -q` → **50 نجحت** · `tools/composer_trial.py --offline` → **8/8**

**على الإنتاج** (رسائل موقّعة حقيقية بعد النشر `746013a`):

| المدخل | الرد | `deterministic_override` | أدوات | زمن |
|---|---|---|---|---|
| السلام عليكم | «وعليكم السلام ورحمة الله وبركاته 🌸 أهلاً وسهلاً! أنا نور…» | False | 0 | 24.6s |
| عايز أعرف مواعيد العمل | «…للأسف ما أقدر أأكد لك مواعيد العمل حالياً…» | False | 1 | 26.8s |
| شكراً جزيلاً | «العفو، أهلاً وسهلاً! 🌸 تحت أمرك بأي وقت…» | False | 0 | 16.6s |

كل الردود صياغة النموذج، صفر قوالب، والأدوات متسجّلة صح، والموديل صحيح في الـ audit.

---

## 7. ملاحظات متبقية (لم تُنفَّذ)

1. **الزمن 17-30 ثانية للتيرن** — السبب بنيوي: 2-3 نداءات متتالية. الحل المقترح: تخطّي
   المؤلف لما الوكيل يكون كتب ردًا مبنيًا على الحقائق ولم يحصل تغيير.
2. **`/debug/llm`** ما زال شغّالًا في الإنتاج — endpoint تشخيصي مؤقت.
3. **تدوير المفاتيح:** GitHub PAT مضمّن في رابط الـ remote · توكن Railway في ملفات مستثناة.
4. **`docs/port_conventions.md`** فيه خرائط لدوال اتشالت — يستحق تحديثًا.
5. **`response_policy.py`** لسه 1,021 سطرًا؛ الجزء الأكبر منه منطق قرار حتمي (مطلوب)،
   لكن يستحق مراجعة تانية لعزل أي بقايا نصوص.

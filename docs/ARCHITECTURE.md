# ARCHITECTURE — agent k2 (خريطة النظام للمراجعة وصيانة اللوجيك)

المسار الحي لكل رسالة مريض (`app/api/v1/message.py`):
`_run` = normalize → HMAC/dedupe/قفل المحادثة → سياق العيادة → وكيل الحوار مع الأدوات
(`services/dialogue.py`) → سلامة العقود (`core/llm_safety.py` r3/r2/r1) → تطبيع العقد
(`core/agent_output.py`) → إصلاح اختياري → حل هويات الحجز → قرار حتمي (`core/orchestrator.py`)
→ بوابات (`core/gates.py`) → دفتر العمليات والمنفذون (`db/repository.py`) → سياسة الرد
(`core/response_policy.py`) → `_respond_tail`: حفظ التأكيد → كتالوج الحقائق + كومبوزر الرد
(`core/response_context.py` + `services/dialogue.compose_patient_reply`) → حفظ الحالة
(`stages_pre.build_persistent_conversation_state`) → الرد النهائي (`pipeline/respond.py`).

## أدوار الملفات
| ملف | الدور |
|---|---|
| `api/v1/message.py` | المنفذ: ترتيب المراحل، قفل المحادثة، مسارات الخروج المبكر، fallback الرد |
| `pipeline/normalize.py` | تطبيع الحمولة الواردة (المفاتيح، الهوية، الوقت، المكرر) |
| `pipeline/stages_pre.py` | بناء سياق الشخصية + **بناء الحالة المحفوظة** (العقل اللي بيقرر إيه اللي يتحفظ) |
| `pipeline/stages_post.py` | تطبيق هويات الحجز، دفتر الـ claim، مظاريف التنفيذ، دمج الاكتمال، handoff |
| `core/orchestrator.py` | جدول قرار آلة الحالة (c1_confirm_execute، العروض، restarts) |
| `core/gates.py` | حارس انتقال التنفيذ + بوابة أوقات العمل |
| `core/agent_output.py` | تطبيع/تحقق عقد k2.dialogue.v4 + امتصاص كلمات الأيام |
| `core/llm_safety.py` | طبقات r3/r2/r1 + برومبت ومدقق سلسلة الإصلاح |
| `core/response_policy.py` | ظرف السياسة: response_code + facts + agent_reply |
| `core/response_context.py` | كتالوج الحقائق + تحقق قيم الكومبوزر/المسودة + بوابة التكلفة |
| `services/dialogue.py` | حلقة أدوات الحوار + استرجاع الكيانات + كومبوزر الرد |
| `services/availability.py` | رحلة التوفر (توقيت، نوافذ، بدائل، عرض مُقدَّم) |
| `db/repository.py` + `queries.py` | كل SQL/RPC — الـ ledger والإيدمبوتنسي والحالة |
| `core/js_semantics.py` | دلالات JS المشتركة — المرجع الوحيد، ممنوع تعريف نسخ محلية |
| `tools/talk_test.py` | اختبار طبيعية حي (قراءة فقط) |
| `tools/deploy_core_engine.py` | النشر — **الـ git مفيهوش auto-deploy** |

## ثوابت لا تُخترق
1. التنفيذ حتمي فقط: النموذج يقترح، orchestrator+ledger ينفذون. ردّ النص لا يفتح باب تنفيذ.
2. مفيش نص ثابت يوصل للمريض — عند فشل كل المصادر: كتم + handoff.
3. كل قيمة في الرد تترجع لحقائق مقتبسة (grounding) — والمسودة الأساسية تمر بنفس البوابة.
4. الـ idempotency من دفتر العمليات — الرد المكرر يرجع برقم الحجز.
5. دلالات JS في js_semantics مرجعها n8n_reference — ممنوع «تبسيطها».

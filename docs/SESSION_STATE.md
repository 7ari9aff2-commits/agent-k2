# SESSION STATE — حالة النظام وسياق العمل (تُحدَّث بعد كل مرحلة)

آخر تحديث: 2026-09-18 بعد كوميت `29323b7..37ae739`. المرجع المعماري: `docs/ARCHITECTURE.md`.

## الوضع الحالي للإنتاج
- آخر كوميت منشور على Railway: `37ae739` (النشر بأمر `python tools/deploy_core_engine.py` — **مفيش auto-deploy من git**).
- الصحة 200، مصادقة `X-K2-Internal-Token` شغالة، 86 اختبار أخضر.
- جدول `ai_requests` يسجل كل نداء LLM (clinic_id, model, input/output/total_tokens, cost, latency).
- `GET /core-engine/usage?clinic_id=&days=` يرجع الإجماليات لكل عيادة (محمي بالتوكن، حي ومُتحقق).

## المنجز اليوم (بالترتيب)
1. إصلاح مصادقة n8n (اعتماد قديم) — كل القنوات رجعت.
2. استرجاع كيانات الوكيل من آثار الأدوات (`dialogue.recover_entities_from_tool_events`).
3. إصلاح 3 فجوات P0 لسلك المفاتيح: `validate_child_envelope`/`finalize`/`persist_pending_confirmation`.
4. قفل تسلسل تيرنات المحادثة (WeakValueDictionary + task-acquire + كتم مؤجل محفوظ).
5. مفيش نصوص ثابتة: كل fallback الثابت اتشال — كتم + handoff عالي الأولوية.
6. بوابة التكلفة: مسودة الوكيل المأصول تُشتر مباشرة والكومبوزر يتخطى (audit يسجل `composer_skipped`).
7. `recent_dialogue` في payload الوكيل — الضمائر والسياق اتحلوا (اختبار الكلام بالأدلة).
8. شخصية محايدة عاطفيا بلهجة بلد العيادة (من `assistant_persona.dialect`).

## فجوات مفتوحة معلنة (بالترتيب)
1. **ذراع ربط العرض بعد تأكيد البيانات**: CONFIRM_PATIENT_DATA affirmative بلا هدف مسبق → تقع CONVERSATION بدل ربط العرض الحي. موثقة في `tests/test_booking_journey.py` (شرطات T6 تصبح صارمة لحظة إضافتها).
2. عمود booking_number في SQL إلغاء/تعديل (تأجيل بقرار المالك — إزاحة عن النص الحرفي).
3. تسلسل عبر أكثر من نسخة Railway (القفل الحالي داخل العملية الواحدة).
4. تأكيد أن الـ deferred worker يعيد الإرسال لنفس الـ endpoint.
5. أسعار التوكن في الإعدادات لتشغيل عمود cost في ai_requests.
6. P2s معروفة: twin drift للـ validators، r3 fence داخل نصوص، قراءة policy["output"] الميتة، mojibake خدمة (اتصلح)، تنسيق عقد مصفوفة JSON.

## قواعد ثابتة للعمل على الكود
- التنفيذ حتمي فقط — النموذج يقترح، orchestrator+ledger ينفذ.
- ممنوع أي نص ثابت يوصل للمريض — كتم + handoff.
- كل قيمة في الرد تترجع لحقائق مقتبسة (grounding على المسودة الأساسية أيضا).
- دلالات JS في `js_semantics.py` مرجعها n8n_reference — ممنوع تبسيطها.
- أي إصلاح له اختبار انحدار في نفس الكوميت (86+ أخضر هو الخط).
- النشر يدوي بالسكريبت بعد كل دفعة + فحص `/health`.

## أدوات التشغيل
- `python tools/talk_test.py` — اختبار طبيعية حي (قراءة فقط).
- `python tools/deploy_core_engine.py` — نشر Railway.
- `python -m pytest tests/ -q` — بوابة كل دفعة.

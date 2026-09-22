# SESSION STATE — حالة النظام وسياق العمل (تُحدَّث بعد كل مرحلة)

آخر تحديث: 2026-09-23 — طبقة قنوات موحدة على FastAPI + تليجرام مقطوع عليها رسمياً (n8n احتياط). المرجع المعماري: `docs/ARCHITECTURE.md` + `docs/AGENT_TOOLS_PLAN.md`.

## دفعة 2026-09-23 — طبقة القنوات الموحدة (المشي خطة النقل)
1. `app/channels/` — قناة في ملف: base.py (pipeline موحد: idempotency على webhook_logs + حل العيادة/المريض/المحادثة بنفس RPCs الـ Supabase + توقيع K2 بنفس SQL + نداء النواة in-process + استخراج الرد بنفس سلسلة الأولويات) + telegram.py + gupshup.py + superchat.py (واتساب/إنستا/ماسنجر) + thikaa.py + meta_whatsapp.py (جاهز لتحول مباشر على ميتا — تبديل المزود = صف قناة جديد + رابط ويبهوك بلا كود).
2. تليجرام مقطوع رسمياً: setWebhook على /channels/telegram/webhook بسر token — n8n حي كاحتياط والتراجع = setWebhook بالرابط القديم.
3. typing مؤشر الكتابة صار جوه الـ pipeline نفسه (10 نبضات × 4 ثواني موازية) لكل قناة تدعمه.
4. أخطاء اتصلاحت في لايف الترحيل: placeholders %s→$N، webhook_logs.id uuid، قيم status المسموحة (pending/processed/failed/ignored)، فك jsonb-as-string.
5. 123 اختبار أخضر (22 جداد للقنوات) + CI أخضر على ريبو النشر.
6. ميزة نافذة الساعتين (ضغط الشات لخلاصة) + إصلاح عطل الحجز (_dig) + إصلاح التليفون المحلي (_u16_index_of) — الدفعة السابقة.
7. متبقي: قطع باقي القنوات على مساراتها الجديدة عند تحديد المزود + ويبهوك المزودين من الكونسولات + D3 أدوات الوكيل.

## إجراء الرجوع للـ n8n (نسخة احتياطية — المحتوى لم يُمَس)
الوركفلو المنقولة كلها standby (تعطيل التفعيل فقط — النودز والكريدنشالز سليمة):
Telegram Reply Nodes، WhatsApp Gupshup، SuperChat ×3، Instagram Channel، agent k2،
k2 - get_available_slots، k2 - search_clinic_faq، Handoff Child v1، SuperChat Router، K2 TG Typing Loop.
الرجوع = (1) إعادة تفعيلها من n8n أو بالـ API، (2) إعادة توجيه ويبهوك كل مزود للرابط القديم على
n8n-production-33955، (3) تليجرام: setWebhook على رابط n8n. شغالة فوراً لأن n8n حي وموصل بـ Postgres.
اللي فضل شغال في n8n: الـ dispatcher الصادر، K2 Inbox Outbound Telegram، المراقبة والتقارير والاحتفاظ.

## دفعة 2026-09-23 مساءً — جسر التنبيهات + الـ deferred worker
1. **جسر تنبيهات المالك** (`app/core/alerting.py`): أي استثناء في النواة أو طبقة القنوات يبعت تنبيه تليجرام فوري للمالك (fire-and-forget + cooldown عشر دقائق لكل نوع) — بيسد عمى الـ n8n Error Monitor عن الجزء المهاجر.
2. **الـ deferred worker in-process** (`app/services/deferred_worker.py`): بورت حرفي لـ 'K2 Deferred Message Worker' — claim كل 5 ثواني بنفس الدوال (k2_claim_deferred_batch_v2/complete/release/log) + replay عبر النواة in-process (metadata.k2_deferred_replay بيرخيص التوقيع) + التسليم لسه عبر الـ n8n dispatcher بنفس الـ auth. شغال من الـ lifespan.
3. **pyflakes gate مسك عطل قبل النشر**: httpx/json ناقصين في الـ worker — البوابة الجديدة اشتغلت زي ما اتصممت.
4. الإعدادات الجديدة على Railway: TELEGRAM_ALERT_BOT_TOKEN/CHAT_ID، OUTBOUND_DISPATCHER_URL/TOKEN، DEFERRED_WORKER_ENABLED=true.
5. 131 اختبار أخضر — شامل سيناريو السباق على السلوت.
6. **إصلاح سباق السلوت (55P03)** — من الفحص العميق الخارجي: لما اتنين يأكدوا نفس السلوت، الداتابيز بترفض التاني بـ FOR UPDATE + raise — كان بيوصل للمريض 500 خام. دلوقتي بيتقفل FAILED_FINAL/NOT_EXECUTED في الدفتر ويرد SLOT_UNAVAILABLE لطيف من الكومبوزر. أخطاء البنية الحقيقية بتفضل تطلع 500 مع إقفال الدفتر INCONCLUSIVE (اختباران منفصلان).
7. **حفظ اسم الدكتور المرفوض** في booking_context.doctor_name_rejected قبل مسحه من الكونتراكت (JS parity للمسح محفوظ — المعلومة اتنقلت للـ audit بدل ما تضيع).
8. **توثيق ثابت target_live**: target بدون expires_at يعيش للأبد (عكس offer_live) — كل منشئ target لازم يحط expires_at (موثق عند الدالة).

## دفعة 2026-09-22 مساءً
1. **إصلاح عطل حجز حي (تليجرام)**: رسالة تأكيد الحجز كانت تضرب 500 INTERNAL_ERROR — `NameError: _dig` في orchestrator.py سطر 1110/1159 (مسار P47/P42 binding) — الدالة كانت ناقصة من فيتشر offer-binding أصلاً واختبارات الرحلة كانت بتعدي سطرها بالقصور الذاتي. أضيفت الدالة بدلالات باقي الوحدات.
2. **إصلاح فيكسچر الاختبار المعتمد على الزمن**: expires_at بتاريخ ثابت 2026-09-19 كان بقى في الماضي ففشّل T5 — بقى 2099. الاختبارات 101/101 أخضر.
3. **ميزة ضغط الجلسة بنافذة ساعتين** (طلب المالك): بعد ساعتين من آخر نشاط، سجل الشات الخام لا يتدفق للنموذج — يتعوّض بخلاصة مهيكلة `previous_session_summary` مشتقة من حقول الحالة فقط (patient_name، booking_context، pending_appointment، last_intent) بدون أي نص مولّد، والحالة المحفوظة تبدأ جلسة خام جديدة. التطبيق: `app/core/session_compact.py` + hook في `dialogue.build_user_message` (payload الوكيل) + `build_persistent_conversation_state` (الحالة المحفوظة). ملاحظة: flag `context_session_reset` القديم كان ميت (محدش بيحطه) — الميزة دي مستقلة عنه.
4. تحقق لايف: رسالة موقّعة بحجز جديد رجعت 200 برد سليم على النشر الجديد، ورسالة محايدة بعد إصلاح الـ Postgres credential (pooler IPv4 + تجاوز الشهادة) رجعت 200.

## الوضع الحالي للإنتاج — الحساب الجديد
- سبب انقطاع الردود: ترايال Railway القديم خلص فاتوقف n8n و Postgres بتوع مشروع ample-beauty — القنوات كانت بتضرب في دومين ميت.
- المشروع الجديد: `stellar-caring` على حساب Railway بالتوكن المحفوظ في سكريبت النشر.
- n8n: `https://n8n-production-33955.up.railway.app` — شغال على Postgres جديد، 25 وركفلو مستوردة، 16 فعالة زي الأصل، الويبهوكس مسجلة ومتحقق منها.
- core-engine: `https://core-engine-production-970a.up.railway.app` — نُشر من ريبو المرآة النظيف `7ari9aff2-commits/agent-k2-deploy`، صحة 200، واختبار رسالة موقّعة كامل رجع 200 برد حقيقي.
- Postgres بتاع n8n: خدمة `Postgres` بنفس بيانات القديم، اتعمل بـ startCommand صريح `docker-entrypoint.sh postgres` — القالب الافتراضي كان نايم بـ sleep infinity.
- agent-k2 التوأم: منشور على `https://agent-k2-production-0fae.up.railway.app` بنفس متغيراته القديمة.
- الكريدنشالز الـ 8 في n8n اتعملوا من جديد بنفس القيم: K2، Header Auth للـ inbox، Custom Auth بمفتاح Supabase، Postgres بدور fastapi_app على الشبكة المباشرة، Novita للنموذجين، تليجرام التوكن اترجع من channels.config.
- الروابط جوه الوركفلو اتحدمت: الدومين الذاتي للجديد، والراوترز مقطوعة على نواة الـ core-engine الجديدة زي قرار القطع 2026-09-18.
- مفتاح n8n API وكريدنشالز المالك محفوظة في `tools/n8n_owner.txt` — المالك admin@meruna.systems، ولينك دعوة لإيميل المالك الشخصي اتولد وسُلّم له.

## المنجز في دفعة 2026-09-19 (فحص عميق + إصلاح)
1. **إغلاق حلقة تأكيد الحجز — جذر الفجوة رقم 1 على ثلاث طبقات:**
   - جدول القرار: صف P42c — تأكيد أو رفض على السلوت المربوط نفسه في AWAIT_CONFIRMATION يروح لمسار c1_confirm_execute أو الرفض، مش إعادة ربط.
   - الـ payload: لستة العروض بتتكتما while فيه تأكيد معلق، لأن قاعدة 1 في البرومبت بتتقدم على قاعدة 2.
   - بنّاء الحالة: هدف التنفيذ المربوط بقى سند احتياطي لـ slot_id/date/time في booking_context وslot_state — فحص الحارس كان بيفشل لأن NAO مش شايف السلوت المربوط من الأدوات.
2. **بوابة grounding على الرد الرجعي:** فشل الكومبوزر مبقاش بيبعت مسودة فاشلة من الفحص — إما تعدي الفحص نفسه أو كتم مع handoff. وشرط رقم الحجز بقى على مصادر التيرن نفسها زي الكومبوزر بالظبط.
3. **حارس الحجز المزدوج:** فحص سلوت-محجوز-نفس-المريض قبل التنفيذ — بيقفل نافذة حجز مزدوج لو تيرن سابق نفذ وباظ قبل حفظ الحالة، لأن الدفتر مفاتهيه لكل عملية.
4. تنضيف respond.py — الثابت الميت اتشال والتوثيق بقى مطابق للسلوك، وتحقق شكل مدخلات نقطة usage.
5. اختبار الرحلة T6 بقى صارم من طرف لطرف: التنفيذ → finalize مكتمل → رقم الحجز محفوظ ويوصل للرد. +8 اختبارات انحدار جديدة.

## المنجز — دفعة 2026-09-18 (تاريخي)
1. إصلاح مصادقة n8n (اعتماد قديم) — كل القنوات رجعت.
2. استرجاع كيانات الوكيل من آثار الأدوات (`dialogue.recover_entities_from_tool_events`).
3. إصلاح 3 فجوات P0 لسلك المفاتيح: `validate_child_envelope`/`finalize`/`persist_pending_confirmation`.
4. قفل تسلسل تيرنات المحادثة (WeakValueDictionary + task-acquire + كتم مؤجل محفوظ).
5. مفيش نصوص ثابتة: كل fallback الثابت اتشال — كتم + handoff عالي الأولوية.
6. بوابة التكلفة: مسودة الوكيل المأصول تُشتر مباشرة والكومبوزر يتخطى (audit يسجل `composer_skipped`).
7. `recent_dialogue` في payload الوكيل — الضمائر والسياق اتحلوا (اختبار الكلام بالأدلة).
8. شخصية محايدة عاطفيا بلهجة بلد العيادة (من `assistant_persona.dialect`).

## فجوات مفتوحة معلنة (بالترتيب)
1. **إعادة توجيه ويبهوك المزودين — الخطوة المتبقية الوحيدة لرجوع حركة المرضى**: Gupshup و SuperChat و Thikaa لسه شايلين دومين n8n القديم الميت. المطلوب في كونسول كل مزود تغيير الكولباك لـ `https://n8n-production-33955.up.railway.app/webhook/…` — المسارات: gupshup-webhook، superchat-whatsapp-webhook، superchat-instagram-webhook، superchat-messenger-webhook، ig-thikaa-webhook. محاولات تحديثها عبر APIs اتاحت 403 أو مسارات غير موجودة.
2. تنبيه المنصة: ترايال عيادات الحنكشلاوي خلص 2026-09-20 (جدول platform_hala_alerts) — قرار المالك.
3. عمود booking_number في SQL إلغاء/تعديل (تأجيل بقرار المالك — إزاحة عن النص الحرفي).
4. تسلسل عبر أكثر من نسخة Railway (القفل الحالي داخل العملية الواحدة).
5. تأكيد أن الـ deferred worker يعيد الإرسال لنفس الـ endpoint.
6. أسعار التوكن في الإعدادات لتشغيل عمود cost في ai_requests.
7. P2s معروفة: twin drift للـ validators، r3 fence داخل نصوص، قراءة policy["output"] الميتة، تنسيق عقد مصفوفة JSON.

## قواعد ثابتة للعمل على الكود
- التنفيذ حتمي فقط — النموذج يقترح، orchestrator+ledger ينفذ.
- ممنوع أي نص ثابت يوصل للمريض — كتم + handoff.
- كل قيمة في الرد تترجع لحقائق مقتبسة (grounding على المسودة الأساسية أيضا).
- دلالات JS في `js_semantics.py` مرجعها n8n_reference — ممنوع تبسيطها.
- أي إصلاح له اختبار انحدار في نفس الكوميت (86+ أخضر هو الخط).
- النشر يدوي بالسكريبت بعد كل دفعة + فحص `/health` — السكريبت الآن يدفع مرآة نظيفة بلا أسرار لريبو `agent-k2-deploy` ثم ينشر للحساب الجديد.

## أدوات التشغيل
- `python tools/talk_test.py` — اختبار طبيعية حي (قراءة فقط).
- `python tools/deploy_core_engine.py` — نشر Railway للحساب الجديد (مرآة + deploy + فحص صحة).
- `python -m pytest tests/ -q` — بوابة كل دفعة.

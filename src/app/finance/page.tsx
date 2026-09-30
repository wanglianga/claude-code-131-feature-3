import Link from "next/link";
import { q } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, KV, Badge } from "@/components/ui";
import { DataForm, ActionButton } from "@/components/client";
import { FEE_TYPES, REFUND_PLAN_STATUS, FAMILY_PLAN_STATUS, money, dt, badgeClass } from "@/lib/labels";

export const dynamic = "force-dynamic";

function planBadge(status: string) {
  switch (status) {
    case "frozen": return <Badge text={REFUND_PLAN_STATUS[status]} cls="badge red" />;
    case "care_verified": return <Badge text={REFUND_PLAN_STATUS[status]} cls="badge amber" />;
    case "family_synced": return <Badge text={REFUND_PLAN_STATUS[status]} cls="badge blue" />;
    case "disputed": return <Badge text={REFUND_PLAN_STATUS.disputed} cls="badge red" />;
    case "reviewed": return <Badge text={REFUND_PLAN_STATUS.reviewed} cls="badge green" />;
    default: return <Badge text={REFUND_PLAN_STATUS[status] || status} cls="badge gray" />;
  }
}

export default async function FinancePage() {
  await requireUser(["finance", "admin"]);
  const stays = q(
    `SELECT s.id, s.mother_name, s.status, s.actual_checkout, s.expected_checkout, r.number, p.name AS package_name,
       (SELECT COALESCE(SUM(CASE WHEN f.direction='charge' THEN f.amount ELSE -f.amount END),0)
          FROM fees f WHERE f.stay_id=s.id AND f.status='confirmed') AS net
     FROM stays s JOIN rooms r ON r.id=s.room_id JOIN packages p ON p.id=s.package_id
     ORDER BY s.status='in_stay' DESC, r.number`);
  const recentFees = q(
    `SELECT f.*, r.number, s.mother_name FROM fees f
     JOIN stays s ON s.id=f.stay_id JOIN rooms r ON r.id=s.room_id
     ORDER BY f.created_at DESC LIMIT 20`);
  const settlements = q(
    `SELECT st.*, r.number, s.mother_name FROM settlements st
     JOIN stays s ON s.id=st.stay_id JOIN rooms r ON r.id=s.room_id
     ORDER BY st.status='draft' DESC, st.created_at DESC`);
  const plans = q(
    `SELECT rp.*, r.number, s.mother_name FROM refund_plans rp
     JOIN stays s ON s.id=rp.stay_id JOIN rooms r ON r.id=s.room_id
     ORDER BY rp.status='reviewed' DESC, rp.updated_at DESC`);
  const activePlans = plans.filter((p) => p.status !== "reviewed" && p.status !== "cancelled");
  const frozenTotal = activePlans.reduce((sum, p) => sum + Number(p.frozen_balance), 0);
  const inStays = stays.filter((s) => s.status === "in_stay");

  return (
    <AppShell title="财务工作台">
      <div className="grid cols-4">
        <div className="stat"><div className="num">{inStays.length}</div><div className="label">在住订单</div></div>
        <div className="stat"><div className="num">{settlements.filter((s) => s.status === "draft").length}</div><div className="label">待确认结算</div></div>
        <div className="stat"><div className="num">{activePlans.length}</div><div className="label">提前退所办理中</div></div>
        <div className="stat"><div className="num">{money(frozenTotal)}</div><div className="label">冻结套餐尾款</div></div>
      </div>

      <Section title="提前退所结算（核对已住天数 / 已执行产康 / 餐食成本 / 赠送服务 / 押金）"
        tone={activePlans.length ? "tone-red" : ""}>
        <details>
          <summary className="muted">发起提前退所退款方案（生成后立即冻结套餐尾款）</summary>
          <DataForm action="refund_plans.create"
            fields={[
              { name: "stayId", label: "订单（房间）", type: "select", required: true, options: inStays.map((s) => ({ value: String(s.id), label: `${s.number} ${s.mother_name}（预计出所${s.expected_checkout}）` })) },
              { name: "checkoutDate", label: "实际退所日期", type: "date", required: true },
              { name: "reason", label: "退所原因", required: true, placeholder: "如：家庭原因需提前回乡" },
              { name: "mealUnitCost", label: "餐食日成本(元/天)", type: "number", defaultValue: 120 },
              { name: "recoveryUnitCost", label: "单次产康成本(元)", type: "number", defaultValue: 380 },
              { name: "giftUnitValue", label: "单项已发赠品折算(元)", type: "number", defaultValue: 300 },
              { name: "otherDeduction", label: "其他扣减(元)", type: "number", defaultValue: 0 },
              { name: "otherAdjustment", label: "其他调整/减免(元)", type: "number", defaultValue: 0 },
              { name: "adjustmentNote", label: "调整说明" },
            ]} submitLabel="核对并冻结套餐尾款" />
        </details>

        {plans.length === 0 && <div className="empty mt8">暂无提前退所退款方案</div>}
        <div className="mt8">
          {plans.map((p) => (
            <div className="stat" key={String(p.id)} style={{ marginBottom: 12 }}>
              <div className="room-head row" style={{ justifyContent: "space-between" }}>
                <b>方案#{String(p.id)} · <Link href={`/stays/${p.stay_id}`}>{String(p.number)}房 {String(p.mother_name)}</Link></b>
                {planBadge(String(p.status))}
              </div>
              <div className="small muted">原因：{String(p.reason)} ｜ 拟退所 {String(p.checkout_date)}（已住 {String(p.stayed_days)} 天 / 剩余 {String(p.remaining_days)} 天）</div>
              <div className="mt8">
                <KV items={[
                  ["房型费用", `${money(p.room_charge)}（日均价 ${money(p.daily_rate)} × ${p.stayed_days}天）`],
                  ["餐食成本", `${money(p.meal_cost)}（${p.meal_days}天 × ${money(p.meal_unit_cost)}）`],
                  ["已执行产康", `${money(p.recovery_cost)}（${p.recovery_done_count}次 × ${money(p.recovery_unit_cost)}）`],
                  ["赠送服务", <span key="g">{money(p.gifts_delivered_value)}<div className="muted small">{String(p.gifts_note)}</div></span>],
                  ["押金", `${money(p.deposit_amount)}（原路退还）`],
                  ["增项 / 其他", `${money(p.extra_charge)} / 扣减 ${money(p.other_deduction)}，调整 ${money(p.other_adjustment)}${p.adjustment_note ? `（${String(p.adjustment_note)}）` : ""}`],
                  ["已消费合计", money(p.total_consumed)],
                  ["应退合计", <b key="r" style={{ color: "#0b7" }}>{money(p.total_refund)}</b>],
                  ["套餐尾款", <span key="f" className="badge red">冻结 {money(p.frozen_balance)}</span>],
                  ["护理动作核对", Number(p.care_verified)
                    ? <span key="y" className="badge green">护士长已核对 {dt(p.care_verified_at)}<div className="muted small">{String(p.care_note)}</div></span>
                    : <span key="n" className="badge amber">待护理主管核对</span>],
                  ["家属端", FAMILY_PLAN_STATUS[String(p.family_status)] ? <Badge key="fs" text={FAMILY_PLAN_STATUS[String(p.family_status)]} cls={p.family_status === "acked" ? "badge green" : p.family_status === "disputed" ? "badge red" : "badge amber"} /> : "-"],
                ]} />
              </div>
              <div className="mt8 row">
                {p.status === "frozen" && (
                  <>
                    <span className="badge amber">等待护士长核对护理动作…</span>
                    <details>
                      <summary className="btn default small">调整金额</summary>
                      <DataForm compact action="refund_plans.update" hidden={{ id: Number(p.id) }}
                        fields={[
                          { name: "mealUnitCost", label: "餐食日成本", type: "number", defaultValue: Number(p.meal_unit_cost) },
                          { name: "recoveryUnitCost", label: "单次产康成本", type: "number", defaultValue: Number(p.recovery_unit_cost) },
                          { name: "giftsValue", label: "赠品折算合计", type: "number", defaultValue: Number(p.gifts_delivered_value) },
                          { name: "otherDeduction", label: "其他扣减", type: "number", defaultValue: Number(p.other_deduction) },
                          { name: "otherAdjustment", label: "其他调整/减免", type: "number", defaultValue: Number(p.other_adjustment) },
                          { name: "adjustmentNote", label: "调整说明" },
                        ]} submitLabel="保存调整" />
                    </details>
                    <ActionButton action="refund_plans.cancel" payload={{ id: Number(p.id) }} label="撤回方案（解冻）" kind="danger" confirm="撤回后套餐尾款冻结解除，确定？" />
                  </>
                )}
                {p.status === "care_verified" && (
                  <ActionButton action="refund_plans.confirm" payload={{ id: Number(p.id) }} label="退款方案同步家属端" kind="primary"
                    confirm="同步后家属端可查看退款明细，确定？" />
                )}
                {p.status === "family_synced" && (
                  <>
                    <span className="small muted">家属状态：{FAMILY_PLAN_STATUS[String(p.family_status)]}</span>
                    <ActionButton action="refund_plans.review" payload={{ id: Number(p.id) }} label="财务复核退款并办理出所" kind="primary"
                      confirm="复核通过后生成退款流水、确认结算单并办理出所，确定？" />
                    <DataForm compact action="refund_plans.review" hidden={{ id: Number(p.id) }}
                      fields={[{ name: "reviewNote", label: "复核意见", defaultValue: "复核无误" }]} submitLabel="带意见复核" />
                  </>
                )}
                {p.status === "disputed" && (
                  <DataForm compact action="refund_plans.resolve_dispute" hidden={{ id: Number(p.id) }}
                    fields={[{ name: "note", label: "异议处理说明（处理后重新同步家属）", required: true }]} submitLabel="处理异议" />
                )}
                {p.status === "reviewed" && (
                  <span className="small muted">财务复核 {dt(p.reviewed_at)}：{String(p.review_note)}（见结算单与退款流水）</span>
                )}
                {p.status === "cancelled" && <span className="small muted">方案已撤回，尾款冻结已解除</span>}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="登记费用 / 退款（套餐尾款冻结期将被拦截）">
        <DataForm action="fees.create"
          fields={[
            { name: "stayId", label: "订单（房间）", type: "select", required: true, options: stays.map((s) => ({ value: String(s.id), label: `${s.number} ${s.mother_name}（${s.status === "in_stay" ? "在住" : "已出所"}）` })) },
            { name: "type", label: "费用类型", type: "select", required: true, options: Object.entries(FEE_TYPES).map(([v, l]) => ({ value: v, label: l })) },
            { name: "direction", label: "方向", type: "select", required: true, options: [{ value: "charge", label: "应收" }, { value: "refund", label: "退款" }] },
            { name: "amount", label: "金额(元)", type: "number", required: true },
            { name: "description", label: "说明", required: true, placeholder: "如：产康加项2次" },
          ]} submitLabel="登记" />
      </Section>

      <Section title="结算单（出所订单）">
        <DataTable cols={["房间", "产妇", "应收", "退款", "实收", "余额", "状态", "操作"]} empty="暂无结算单"
          rows={settlements.map((s) => [
            <Link key="r" href={`/stays/${s.stay_id}`}>{String(s.number)}</Link>,
            String(s.mother_name),
            money(s.total_charge), money(s.total_refund), money(s.paid),
            <b key="b">{money(s.balance)}</b>,
            <Badge key="st" text={s.status === "confirmed" ? "已确认" : "待确认"} cls={badgeClass(String(s.status))} />,
            s.status !== "confirmed"
              ? <ActionButton key="c" action="settlements.confirm" payload={{ stayId: Number(s.stay_id) }} label="确认结算" kind="primary" confirm="确认该订单结算无误？" />
              : <span key="d" className="muted small">{dt(s.confirmed_at)}</span>,
          ])} />
      </Section>

      <Section title="费用流水（全部房间）">
        <DataTable cols={["时间", "房间", "产妇", "类型", "说明", "方向", "金额", "状态"]} empty="暂无费用"
          rows={recentFees.map((f) => [
            <span key="t" className="small">{dt(f.created_at)}</span>,
            <Link key="r" href={`/stays/${f.stay_id}`}>{String(f.number)}</Link>,
            String(f.mother_name),
            FEE_TYPES[String(f.type)] || String(f.type),
            String(f.description),
            f.direction === "refund" ? <span key="d" className="badge blue">退款</span> : <span key="c" className="badge gray">应收</span>,
            <b key="m">{money(f.amount)}</b>,
            <Badge key="s" text={f.status === "void" ? "已作废" : "已确认"} cls={badgeClass(String(f.status))} />,
          ])} />
      </Section>
    </AppShell>
  );
}

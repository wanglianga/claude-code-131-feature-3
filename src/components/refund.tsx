// 套餐提前退所退款方案面板：财务/护士长/家属/房间360视图共用
import Link from "next/link";
import { Section, KV, Badge } from "./ui";
import { DataForm, ActionButton } from "./client";
import { REFUND_STATUS, money, dt, badgeClass } from "@/lib/labels";
import type { SessionUser } from "@/lib/auth";

type Row = Record<string, unknown>;

function Step(props: { n: number; label: string; done: boolean; active?: boolean }) {
  return (
    <span className={`badge ${props.done ? "green" : props.active ? "amber" : "gray"}`} style={{ marginRight: 6 }}>
      {props.done ? "✓" : props.n} {props.label}
    </span>
  );
}

export function RefundPanel(props: {
  plan: Row;
  events?: Row[];
  user: SessionUser;
  roomNumber?: string;
  compact?: boolean;
  readOnly?: boolean;
}) {
  const { plan: p, user } = props;
  const readOnly = props.readOnly || user.role === "family";
  const canFinance = !readOnly && ["finance", "admin"].includes(user.role);
  const canHead = !readOnly && ["head_nurse", "admin"].includes(user.role);
  const canFront = !readOnly && ["frontdesk", "admin"].includes(user.role);
  const status = String(p.status);
  const finished = status === "refunded";
  const rejected = status === "rejected";

  const frozen = Number(p.frozen) === 1;
  const careOk = Number(p.care_confirmed) === 1;
  const synced = Number(p.family_synced) === 1;
  const generated = ["generated", "frozen", "care_confirmed", "family_synced", "reviewed", "refunded"].includes(status);

  let gifts: { name: string; value: number }[] = [];
  try { gifts = JSON.parse(String(p.gifts_detail || "[]")); } catch { gifts = []; }

  const steps = (
    <div className="mt8" style={{ lineHeight: 2.2 }}>
      <Step n={1} label="平台核对" done />
      <Step n={2} label="财务出方案" done={generated} active={status === "draft" || rejected} />
      <Step n={3} label="冻结套餐尾款" done={frozen} active={status === "generated" || rejected} />
      <Step n={4} label="护士长护理核对" done={careOk} active={frozen && !careOk} />
      <Step n={5} label="同步家属端" done={synced} active={careOk && !synced} />
      <Step n={6} label="财务复核退款" done={finished} active={synced && !finished} />
    </div>
  );

  return (
    <Section
      title={props.roomNumber ? `${props.roomNumber}房 · 套餐提前退所退款方案` : "套餐提前退所退款方案"}
      tone={finished ? "" : "tone-red"}
      extra={
        <span className="row">
          <Badge text={REFUND_STATUS[status] || status} cls={badgeClass(status)} />
          {frozen && !finished && <Badge text={`套餐尾款冻结 ${money(p.tail_frozen)}`} cls="badge amber" />}
          {p.stay_id ? <Link className="btn default small" href={`/stays/${p.stay_id}`}>房间视图</Link> : null}
        </span>
      }
    >
      <KV items={[
        ["退所原因", String(p.apply_reason || "-")],
        ["申请 / 应出所", `${dt(p.planned_checkout)}（申请退所） / ${dt(p.expected_checkout)}（应出所）`],
        ["已住 / 剩余天数", `${p.lived_days} 天 / ${p.remain_days} 天（套餐 ${p.package_days} 天，日均价 ${money(Math.round(Number(p.daily_price)))}）`],
        ["已执行产康", `${p.recovery_done_count} 节（待执行/改期 ${p.recovery_scheduled_count} 节，已执行成本约 ${money(p.recovery_fee)}）`],
        ["餐食成本", `实际配餐 ${p.meal_days} 天，合计 ${money(p.meal_cost)}`],
        ["赠送服务", `${gifts.length ? gifts.map((g) => g.name).join("、") : "无"}（已发放按估值扣回 ${money(p.gifts_total)}）`],
        ["押金 / 已收", `${money(p.deposit)}（全额退） / 已收合计 ${money(p.paid_amount)}`],
      ]} />

      <div className="grid cols-4 mt8">
        <div className="stat"><div className="num">{money(p.stay_fee)}</div><div className="label">已住天数折算</div></div>
        <div className="stat"><div className="num">{money(p.tail_frozen)}</div><div className="label">套餐尾款（冻结）</div></div>
        <div className="stat"><div className="num">{money(p.adjustment)}</div><div className="label">手工调整</div></div>
        <div className="stat"><div className="num">{money(p.refund_amount)}</div><div className="label">应退合计</div></div>
      </div>
      <div className="muted small mt8" style={{ whiteSpace: "pre-line" }}>{String(p.detail || "")}</div>

      {steps}

      {/* 护理核对结论 */}
      {careOk && (
        <div className="mt8 small">
          <span className="badge green">护理已核对</span>
          <span className="muted"> {dt(p.care_confirmed_at)} · {String(p.care_note || "")}</span>
        </div>
      )}
      {synced && <div className="mt8 small"><span className="badge green">已同步家属端</span> <span className="muted">{dt(p.family_synced_at)}</span></div>}
      {finished && <div className="mt8 small"><span className="badge green">财务已复核退款</span> <span className="muted">{dt(p.reviewed_at)} · {String(p.review_result || "")}</span></div>}
      {rejected && <div className="mt8 small"><span className="badge gray">复核驳回</span> <span className="muted">{String(p.review_result || "")}，可调整后重新生成方案</span></div>}

      {/* 操作区 */}
      {!finished && (
        <div className="mt16">
          {/* 财务：生成/重新生成方案（可手工调整） */}
          {canFinance && !frozen && (
            <DataForm compact action="refunds.generate" hidden={{ stayId: Number(p.stay_id) }}
              fields={[
                { name: "adjustment", label: "手工调整(元，减扣填负)", type: "number", defaultValue: Number(p.adjustment) || 0 },
                { name: "adjustmentNote", label: "调整说明", defaultValue: String(p.adjustment_note || "") },
              ]} submitLabel={generated || rejected ? "重新核算方案" : "生成退款方案"} />
          )}

          {/* 财务：冻结套餐尾款（方案生成后） */}
          {canFinance && !frozen && generated && status !== "draft" && (
            <div className="mt8">
              <ActionButton action="refunds.freeze" payload={{ stayId: Number(p.stay_id) }} kind="primary"
                label={`确认方案并冻结套餐尾款 ${money(p.tail_frozen)}`}
                confirm="退款方案确认前冻结套餐尾款，冻结后转护士长核对护理动作。确认冻结？" />
            </div>
          )}

          {/* 护士长：核对护理动作 */}
          {canHead && frozen && !careOk && (
            <DataForm compact action="refunds.careConfirm" hidden={{ stayId: Number(p.stay_id) }}
              fields={[
                { name: "note", label: "护理核对说明", placeholder: "如：查房/伤口/乳房护理/产康/月子餐均已核对一致" },
                { name: "disputeAck", label: "有家属质疑记录时，确认已单独核实", type: "checkbox" },
              ]} submitLabel="确认护理动作已全部核对" />
          )}

          {/* 同步家属端：财务/护士长/前台 */}
          {(canFinance || canHead || canFront) && careOk && !synced && (
            <div className="mt8">
              <ActionButton action="refunds.syncFamily" payload={{ stayId: Number(p.stay_id) }} kind="primary"
                label="将退款方案同步家属端" confirm="核对明细与应退金额将推送至家属端，确认同步？" />
            </div>
          )}

          {/* 财务复核 */}
          {canFinance && synced && !finished && (
            <div className="grid cols-2 mt8">
              <div>
                <ActionButton action="refunds.review" payload={{ stayId: Number(p.stay_id), op: "approve" }} kind="primary"
                  label={`复核通过，退款 ${money(p.refund_amount)} 并办理出所`}
                  confirm="将生成退款流水、确认结算单并正式办理出所，确认复核通过？" />
              </div>
              <DataForm compact action="refunds.review" hidden={{ stayId: Number(p.stay_id), op: "reject" }}
                fields={[{ name: "note", label: "驳回原因（需重新核算）", placeholder: "如：餐食成本/赠品扣回需复核" }]}
                submitLabel="驳回重新核算" />
            </div>
          )}

          {/* 待办提示 */}
          {!readOnly && (
          <div className="muted small mt8">
            {!generated && "等待财务生成退款方案；"}
            {generated && !frozen && "等待财务确认方案并冻结套餐尾款；"}
            {frozen && !careOk && "等待护士长核对已完成护理动作（避免费用与服务记录脱节）；"}
            {careOk && !synced && "等待将退款方案同步家属端；"}
            {synced && !finished && "等待财务复核退款；"}
          </div>
          )}
        </div>
      )}

      {/* 流程时间线 */}
      {props.events && props.events.length > 0 && (
        <details className="mt8" open={!props.compact}>
          <summary className="muted">退款方案处理记录</summary>
          <ul className="timeline">
            {props.events.map((ev) => (
              <li key={String(ev.id)}>
                <span className="t-time">{dt(ev.created_at)}</span>
                <b>{String(ev.user_name)}</b> {String(ev.action)}：{String(ev.note)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}

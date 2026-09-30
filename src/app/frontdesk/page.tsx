import Link from "next/link";
import { q } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, Badge } from "@/components/ui";
import { DataForm, ActionButton } from "@/components/client";
import { VISIT_STATUS, money, dt, badgeClass } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function FrontdeskPage() {
  await requireUser(["frontdesk", "admin"]);
  const rooms = q("SELECT * FROM rooms ORDER BY number");
  const packages = q("SELECT * FROM packages ORDER BY price");
  const vacantRooms = rooms.filter((r) => r.status === "vacant");
  const pendingVisits = q(
    `SELECT v.*, r.number, s.mother_name FROM visits v
     JOIN stays s ON s.id=v.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE v.status IN ('pending','approved') ORDER BY v.visit_time`);
  const pendingGifts = q(
    `SELECT g.*, r.number, s.mother_name FROM gifts g
     JOIN stays s ON s.id=g.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE g.status='pending' AND s.status='in_stay' ORDER BY g.id`);
  const inStays = q(
    `SELECT s.id, s.mother_name, s.check_in_date, s.expected_checkout, r.number, p.name AS package_name
     FROM stays s JOIN rooms r ON r.id=s.room_id JOIN packages p ON p.id=s.package_id
     WHERE s.status='in_stay' ORDER BY r.number`);

  return (
    <AppShell title="前台工作台">
      <div className="grid cols-3">
        <div className="stat"><div className="num">{rooms.filter((r) => r.status === "occupied").length}</div><div className="label">在住房间</div></div>
        <div className="stat"><div className="num">{vacantRooms.length}</div><div className="label">空房</div></div>
        <div className="stat"><div className="num">{pendingVisits.filter((v) => v.status === "pending").length}</div><div className="label">待审核探访</div></div>
      </div>

      <Section title="房间状态">
        <div className="grid cols-4">
          {rooms.map((r) => (
            <div className="stat" key={String(r.id)}>
              <div className="room-head row" style={{ justifyContent: "space-between" }}>
                <b style={{ fontSize: 18 }}>{String(r.number)}</b>
                <Badge
                  text={r.status === "occupied" ? "在住" : r.status === "vacant" ? "空房" : "清扫中"}
                  cls={r.status === "occupied" ? "badge blue" : r.status === "vacant" ? "badge green" : "badge amber"} />
              </div>
              <div className="small muted">{String(r.type)} · {String(r.floor)}</div>
              {r.status === "cleaning" && (
                <div className="mt8">
                  <ActionButton action="rooms.update" payload={{ id: Number(r.id), status: "vacant" }} label="清扫完成→空房" kind="primary" />
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title="产妇入住登记（自动建护理计划/赠品/费用/家属账号）">
        <DataForm action="stays.create"
          fields={[
            { name: "motherName", label: "产妇姓名", required: true },
            { name: "motherPhone", label: "产妇电话" },
            { name: "roomId", label: "房间", type: "select", required: true, options: vacantRooms.map((r) => ({ value: String(r.id), label: `${r.number}（${r.type}）` })) },
            { name: "packageId", label: "房型套餐", type: "select", required: true, options: packages.map((p) => ({ value: String(p.id), label: `${p.name}（${money(p.price)} / ${p.days}天 / ${p.room_type}）` })) },
            { name: "checkInDate", label: "入住日期", type: "date", required: true },
            { name: "deliveryMethod", label: "分娩方式", type: "select", required: true, options: [{ value: "顺产", label: "顺产" }, { value: "剖宫产", label: "剖宫产" }, { value: "顺产转剖宫产", label: "顺产转剖宫产" }] },
            { name: "postpartumDays", label: "产后天数", type: "number", required: true },
            { name: "feedingMethod", label: "哺乳方式", type: "select", required: true, options: [{ value: "母乳喂养", label: "母乳喂养" }, { value: "混合喂养", label: "混合喂养" }, { value: "人工喂养", label: "人工喂养" }] },
            { name: "allergyHistory", label: "过敏史", placeholder: "如：青霉素过敏；海鲜过敏" },
            { name: "mealTaboos", label: "餐食禁忌", placeholder: "如：忌辛辣、忌海鲜" },
            { name: "doctorAdvice", label: "医生建议", type: "textarea" },
            { name: "babyName", label: "宝宝小名" },
            { name: "babyWeight", label: "宝宝体重(kg)", type: "number", step: "0.01" },
            { name: "jaundiceLevel", label: "黄疸值(mg/dL)", type: "number", step: "0.1" },
            { name: "jaundiceNote", label: "黄疸观察" },
            { name: "visitors", label: "授权探访家属（顿号分隔）", placeholder: "如：张强（丈夫）、李秀兰（婆婆）" },
            { name: "deposit", label: "押金(元)", type: "number" },
            { name: "familyUsername", label: "家属登录账号" },
            { name: "familyPassword", label: "家属登录密码", placeholder: "默认 family123" },
            { name: "familyName", label: "家属姓名" },
            { name: "familyRelation", label: "与产妇关系", placeholder: "如：丈夫" },
          ]}
          submitLabel="办理入住" />
      </Section>

      <div className="grid cols-2">
        <Section title="探访预约审核 / 消毒登记">
          <DataTable cols={["房间", "探访人", "时间", "状态", "消毒", "操作"]} empty="暂无探访申请"
            rows={pendingVisits.map((v) => [
              <Link key="r" href={`/stays/${v.stay_id}`}>{String(v.number)}</Link>,
              <span key="v">{String(v.visitor_name)}{Number(v.is_temp) ? <span className="badge amber">临时</span> : null}</span>,
              <span key="t" className="small">{dt(v.visit_time)}</span>,
              <Badge key="s" text={VISIT_STATUS[String(v.status)] || ""} cls={badgeClass(String(v.status))} />,
              Number(v.disinfected) ? <span key="d" className="badge green">已消毒</span> : <span key="nd" className="badge gray">未登记</span>,
              <span key="ops" className="row">
                {v.status === "pending" && <>
                  <ActionButton action="visits.update" payload={{ id: Number(v.id), op: "approve" }} label="批准" kind="primary" />
                  <ActionButton action="visits.update" payload={{ id: Number(v.id), op: "reject" }} label="拒绝" kind="danger" />
                </>}
                {v.status === "approved" && !Number(v.disinfected) &&
                  <ActionButton action="visits.update" payload={{ id: Number(v.id), op: "disinfect" }} label="消毒登记" />}
                {v.status === "approved" &&
                  <ActionButton action="visits.update" payload={{ id: Number(v.id), op: "complete" }} label="完成" />}
              </span>,
            ])} />
        </Section>

        <Section title="待发放赠品">
          <DataTable cols={["房间", "产妇", "赠品", "操作"]} empty="暂无待发放赠品"
            rows={pendingGifts.map((g) => [
              <Link key="r" href={`/stays/${g.stay_id}`}>{String(g.number)}</Link>,
              String(g.mother_name), String(g.name),
              <ActionButton key="b" action="gifts.deliver" payload={{ id: Number(g.id) }} label="发放" kind="primary" />,
            ])} />
          <div className="mt8 muted small">在住订单（点击进入房间360视图办理升级/退所）：</div>
          <DataTable cols={["房间", "产妇", "套餐", "预计出所"]}
            rows={inStays.map((s) => [
              <Link key="r" href={`/stays/${s.id}`}>{String(s.number)}</Link>,
              String(s.mother_name), String(s.package_name), String(s.expected_checkout),
            ])} />
        </Section>
      </div>
    </AppShell>
  );
}

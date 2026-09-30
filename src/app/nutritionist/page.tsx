import Link from "next/link";
import { q, today } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, Badge } from "@/components/ui";
import { DataForm } from "@/components/client";
import { EX_STATUS, badgeClass } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function NutritionistPage() {
  await requireUser(["nutritionist", "admin"]);
  const todayStr = today();
  const inStays = q(
    `SELECT s.id, s.mother_name, s.meal_taboos, s.allergy_history, r.number
     FROM stays s JOIN rooms r ON r.id=s.room_id WHERE s.status='in_stay' ORDER BY r.number`);
  const meals = q(
    `SELECT m.*, r.number, s.mother_name FROM meals m
     JOIN stays s ON s.id=m.stay_id JOIN rooms r ON r.id=s.room_id
     ORDER BY m.meal_date DESC, m.id DESC LIMIT 20`);
  const tabooExceptions = q(
    `SELECT e.*, r.number FROM exceptions e
     JOIN stays s ON s.id=e.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE e.type='meal_taboo' AND e.status IN ('open','processing') ORDER BY e.created_at DESC`);

  return (
    <AppShell title="营养师工作台">
      <div className="grid cols-3">
        <div className="stat"><div className="num">{inStays.length}</div><div className="label">在住配餐对象</div></div>
        <div className="stat"><div className="num">{tabooExceptions.length}</div><div className="label">忌口异常待处理</div></div>
        <div className="stat"><div className="num">{meals.filter((m) => m.meal_date === todayStr).length}</div><div className="label">今日已登记餐次</div></div>
      </div>

      <Section title="忌口异常（需立即调整）" tone={tabooExceptions.length ? "tone-red" : ""}>
        <DataTable cols={["房间", "异常内容", "状态", "处理"]} empty="暂无忌口异常"
          rows={tabooExceptions.map((e) => [
            <Link key="r" href={`/stays/${e.stay_id}`}>{String(e.number)}</Link>,
            <span key="t">{String(e.title)}<div className="muted small">{String(e.description)}</div></span>,
            <Badge key="s" text={EX_STATUS[String(e.status)] || ""} cls={badgeClass(String(e.status))} />,
            <DataForm key="f" compact action="exceptions.update" hidden={{ id: Number(e.id) }}
              fields={[
                { name: "op", label: "操作", type: "select", required: true, options: [
                  { value: "accept", label: "受理" }, { value: "resolve", label: "解决" }] },
                { name: "note", label: "调整方案", required: true, placeholder: "如：已更换为清蒸鸡肉，后续每餐双人核对" },
              ]} submitLabel="提交" />,
          ])} />
      </Section>

      <Section title="登记月子餐（提交时自动核对产妇忌口）">
        <DataForm action="meals.create"
          fields={[
            { name: "stayId", label: "房间", type: "select", required: true, options: inStays.map((s) => ({ value: String(s.id), label: `${s.number} ${s.mother_name}（忌口：${s.meal_taboos || "无"}）` })) },
            { name: "mealDate", label: "日期", type: "date", required: true, defaultValue: todayStr },
            { name: "mealType", label: "餐次", type: "select", required: true, options: ["早餐", "午餐", "晚餐", "加餐"].map((v) => ({ value: v, label: v })) },
            { name: "menu", label: "菜单", type: "textarea", required: true, placeholder: "如：山药排骨汤、清蒸鲈鱼、时蔬、软米饭" },
          ]} submitLabel="登记并核对忌口" />
      </Section>

      <div className="grid cols-2">
        <Section title="在住产妇忌口档案">
          <DataTable cols={["房间", "产妇", "餐食禁忌", "过敏史"]}
            rows={inStays.map((s) => [
              <Link key="r" href={`/stays/${s.id}`}>{String(s.number)}</Link>,
              String(s.mother_name),
              <span key="t" className="badge amber">{String(s.meal_taboos || "无")}</span>,
              String(s.allergy_history || "无"),
            ])} />
        </Section>
        <Section title="配餐记录">
          <DataTable cols={["日期", "房间", "餐次", "菜单", "忌口核对"]} empty="暂无配餐记录"
            rows={meals.map((m) => [
              String(m.meal_date),
              <Link key="r" href={`/stays/${m.stay_id}`}>{String(m.number)}</Link>,
              String(m.meal_type), String(m.menu),
              m.taboo_hits ? <span key="h" className="badge red">命中：{String(m.taboo_hits)}</span> : <span key="ok" className="badge green">通过</span>,
            ])} />
        </Section>
      </div>
    </AppShell>
  );
}

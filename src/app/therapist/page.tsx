import Link from "next/link";
import { q } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, Badge } from "@/components/ui";
import { DataForm, ActionButton } from "@/components/client";
import { dt, badgeClass } from "@/lib/labels";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = { scheduled: "已排班", done: "已完成", delayed: "已延期", cancelled: "已取消" };

export default async function TherapistPage() {
  const user = await requireUser(["therapist", "admin"]);
  const schedules = q(
    `SELECT ts.*, r.number, s.mother_name FROM therapist_schedules ts
     JOIN stays s ON s.id=ts.stay_id JOIN rooms r ON r.id=s.room_id
     ORDER BY ts.status='scheduled' DESC, ts.scheduled_at LIMIT 30`);
  const inStays = q(
    `SELECT s.id, s.mother_name, r.number FROM stays s JOIN rooms r ON r.id=s.room_id
     WHERE s.status='in_stay' ORDER BY r.number`);
  const delays = q(
    `SELECT e.*, r.number FROM exceptions e JOIN stays s ON s.id=e.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE e.type='project_delay' ORDER BY e.created_at DESC LIMIT 10`);

  return (
    <AppShell title="产康师工作台">
      <div className="grid cols-3">
        <div className="stat"><div className="num">{schedules.filter((s) => s.status === "scheduled").length}</div><div className="label">待上课程</div></div>
        <div className="stat"><div className="num">{schedules.filter((s) => s.status === "done").length}</div><div className="label">已完成课程</div></div>
        <div className="stat"><div className="num">{schedules.filter((s) => s.status === "delayed").length}</div><div className="label">延期课程</div></div>
      </div>

      <Section title="我的产康排班">
        <DataTable cols={["房间", "项目", "时间", "状态", "操作"]} empty="暂无排班"
          rows={schedules.map((s) => [
            <Link key="r" href={`/stays/${s.stay_id}`}>{String(s.number)} {String(s.mother_name)}</Link>,
            String(s.project),
            <span key="t" className="small">{dt(s.scheduled_at)}</span>,
            <Badge key="s" text={STATUS_LABELS[String(s.status)] || String(s.status)} cls={badgeClass(String(s.status))} />,
            s.status === "scheduled" ? (
              <span key="ops" className="row">
                <ActionButton action="schedules.update" payload={{ id: Number(s.id), op: "done" }} label="完成" kind="primary" />
                <DataForm compact action="schedules.update" hidden={{ id: Number(s.id), op: "delay" }}
                  fields={[
                    { name: "reason", label: "延期原因", required: true },
                    { name: "newTime", label: "改期至", type: "datetime-local", required: true },
                  ]} submitLabel="延期" />
              </span>
            ) : <span key="x" className="muted small">{String(s.delay_reason || "-")}</span>,
          ])} />
      </Section>

      <div className="grid cols-2">
        <Section title="新增排班">
          <DataForm action="schedules.create"
            fields={[
              { name: "stayId", label: "房间", type: "select", required: true, options: inStays.map((s) => ({ value: String(s.id), label: `${s.number} ${s.mother_name}` })) },
              { name: "project", label: "项目", required: true, placeholder: "如 盆底肌修复（第4节）" },
              { name: "scheduledAt", label: "上课时间", type: "datetime-local", required: true },
            ]} submitLabel="排班" />
        </Section>
        <Section title="延期记录（自动生成异常工单）">
          <DataTable cols={["房间", "内容", "状态"]} empty="暂无延期"
            rows={delays.map((e) => [
              <Link key="r" href={`/stays/${e.stay_id}`}>{String(e.number)}</Link>,
              <span key="t">{String(e.title)}<div className="muted small">{String(e.resolution || e.description)}</div></span>,
              <Badge key="s" text={String(e.status) === "resolved" ? "已解决" : "处理中"} cls={badgeClass(String(e.status))} />,
            ])} />
        </Section>
      </div>
    </AppShell>
  );
}

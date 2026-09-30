"use client";
// 通用客户端组件：数据表单 / 动作按钮 / 登录 / 登出
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

export type FieldDef = {
  name: string;
  label: string;
  type?: "text" | "number" | "date" | "datetime-local" | "select" | "textarea" | "checkbox" | "password";
  options?: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
  defaultValue?: string | number | boolean;
  step?: string;
};

async function postDo(payload: Record<string, unknown>) {
  const res = await fetch("/api/do", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export function DataForm(props: {
  action: string;
  fields: FieldDef[];
  hidden?: Record<string, string | number | boolean>;
  submitLabel?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const fd = new FormData(e.currentTarget);
    const payload: Record<string, unknown> = { ...(props.hidden || {}) };
    for (const f of props.fields) {
      if (f.type === "checkbox") {
        payload[f.name] = fd.get(f.name) === "on";
      } else if (f.type === "number") {
        payload[f.name] = Number(fd.get(f.name) || 0);
      } else {
        payload[f.name] = String(fd.get(f.name) ?? "");
      }
    }
    // 外层 action 为动作分发键，最后写入避免被同名字段覆盖（子操作统一用 op）
    payload.action = props.action;
    try {
      const r = await postDo(payload);
      if (r.ok) {
        setMsg({ ok: true, text: r.message || "操作成功" });
        (e.target as HTMLFormElement).reset();
        router.refresh();
      } else {
        setMsg({ ok: false, text: r.error || "操作失败" });
      }
    } catch {
      setMsg({ ok: false, text: "网络错误" });
    }
    setBusy(false);
  }

  return (
    <form onSubmit={onSubmit} className={props.compact ? "form compact" : "form"}>
      {props.fields.map((f) => (
        <label key={f.name} className={f.type === "checkbox" ? "field checkbox" : "field"}>
          <span>{f.label}{f.required ? " *" : ""}</span>
          {f.type === "select" ? (
            <select name={f.name} required={f.required} defaultValue={String(f.defaultValue ?? "")}>
              <option value="" disabled>请选择</option>
              {(f.options || []).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : f.type === "textarea" ? (
            <textarea name={f.name} required={f.required} placeholder={f.placeholder} rows={2} defaultValue={String(f.defaultValue ?? "")} />
          ) : f.type === "checkbox" ? (
            <input type="checkbox" name={f.name} defaultChecked={Boolean(f.defaultValue)} />
          ) : (
            <input
              type={f.type || "text"}
              name={f.name}
              required={f.required}
              placeholder={f.placeholder}
              step={f.step}
              defaultValue={f.defaultValue !== undefined ? String(f.defaultValue) : undefined}
            />
          )}
        </label>
      ))}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "提交中…" : props.submitLabel || "提交"}
        </button>
        {msg && <span className={msg.ok ? "msg ok" : "msg err"}>{msg.text}</span>}
      </div>
    </form>
  );
}

export function ActionButton(props: {
  action: string;
  payload?: Record<string, unknown>;
  label: ReactNode;
  confirm?: string;
  kind?: "primary" | "danger" | "default";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function onClick() {
    if (props.confirm && !window.confirm(props.confirm)) return;
    setBusy(true);
    try {
      const r = await postDo({ ...(props.payload || {}), action: props.action });
      if (!r.ok) window.alert(r.error || "操作失败");
      else if (r.message) window.alert(r.message);
      router.refresh();
    } catch {
      window.alert("网络错误");
    }
    setBusy(false);
  }
  return (
    <button onClick={onClick} disabled={busy} className={`btn ${props.kind || "default"} small`}>
      {busy ? "…" : props.label}
    </button>
  );
}

export function LoginForm() {
  const router = useRouter();
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "login", username: fd.get("username"), password: fd.get("password") }),
    });
    const r = await res.json();
    setBusy(false);
    if (r.ok) {
      router.push("/");
      router.refresh();
    } else {
      setErr(r.error || "登录失败");
    }
  }
  return (
    <form onSubmit={onSubmit} className="form login-form">
      <label className="field">
        <span>用户名</span>
        <input name="username" required autoFocus placeholder="如 nurse1" />
      </label>
      <label className="field">
        <span>密码</span>
        <input name="password" type="password" required placeholder="••••••" />
      </label>
      {err && <div className="msg err">{err}</div>}
      <button className="btn primary block" disabled={busy}>{busy ? "登录中…" : "登 录"}</button>
    </form>
  );
}

export function LogoutButton() {
  const router = useRouter();
  async function logout() {
    await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    router.push("/login");
    router.refresh();
  }
  return <button onClick={logout} className="btn default small">退出登录</button>;
}

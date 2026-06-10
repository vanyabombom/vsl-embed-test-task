import Link from "next/link";

export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
        textAlign: "center",
        gap: 16,
      }}
    >
      <h1>VSL Player Test Task</h1>
      <p style={{ maxWidth: 480, color: "#666", lineHeight: 1.5 }}>
        Self-hosted VSL player replacement for Vidalytics. Read the README for
        the full task description.
      </p>
      <Link
        href="/vsl-test"
        style={{
          padding: "12px 24px",
          background: "#1a1b1f",
          color: "#fff",
          borderRadius: 8,
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        Open the test page →
      </Link>
    </main>
  );
}

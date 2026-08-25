import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <main
      className="min-h-screen flex items-center justify-center px-6"
      style={{ background: "var(--rd-paper)" }}
    >
      <SignIn
        appearance={{
          variables: {
            colorPrimary: "#7a2e2e",
            colorText: "#211d19",
            colorTextSecondary: "#55504a",
            colorBackground: "#ffffff",
            colorInputBackground: "#ffffff",
            colorInputText: "#211d19",
            borderRadius: "0.5rem",
            fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
          },
        }}
      />
    </main>
  );
}

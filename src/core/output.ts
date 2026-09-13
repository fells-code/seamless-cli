import kleur from "kleur";

export function printSuccessOutput(config: {
  projectName?: string;
  root: string;
  webFramework: string | null;
  apiFramework: string | null;
  mobileFramework?: string | null;
  authMode: "local" | "docker";
  adminMode: "api" | "image" | "source" | "none";
  ownerEmail: string;
}) {
  const {
    projectName,
    webFramework,
    apiFramework,
    mobileFramework = null,
    authMode,
    adminMode,
    ownerEmail,
  } = config;

  // Where the admin console lives: proxied by the app API at /console, or a
  // standalone container on 5174. "none" scaffolds no console at all.
  const consoleUrl =
    adminMode === "api"
      ? "http://localhost:3000/console"
      : adminMode === "none"
        ? null
        : "http://localhost:5174";

  const title = kleur.bold().cyan("SEAMLESS");

  console.log(`
╔════════════════════════════════════════╗
║          ${title}                      ║
╚════════════════════════════════════════╝
`);

  console.log(kleur.green("Project initialized successfully.\n"));

  if (projectName) {
    console.log(kleur.dim("Project directory: ") + kleur.bold(projectName));
    console.log(kleur.cyan(`cd ${projectName}\n`));
  }

  console.log(kleur.bold("Included services:\n"));

  if (webFramework) {
    console.log(
      "  • " +
        kleur.white("Web application") +
        kleur.dim(` (${formatFramework(webFramework)})`),
    );
  }

  if (apiFramework) {
    console.log(
      "  • " +
        kleur.white("API server") +
        kleur.dim(` (${formatFramework(apiFramework)})`),
    );
  }

  if (mobileFramework) {
    console.log(
      "  • " +
        kleur.white("Mobile app") +
        kleur.dim(` (${formatFramework(mobileFramework)})`),
    );
  }

  console.log(
    "  • " +
      kleur.white("Auth server") +
      kleur.dim(authMode === "local" ? " (local source)" : " (Docker image)"),
  );

  if (consoleUrl) {
    console.log(
      "  • " +
        kleur.white("Admin console") +
        kleur.dim(
          adminMode === "api" ? " (served by API at /console)" : " (management UI)",
        ),
    );
  }

  console.log("");

  console.log(kleur.bold("Next steps:\n"));

  console.log("  1. Start services");
  console.log(kleur.cyan("     docker compose up\n"));

  console.log("  2. Register in the browser with " + kleur.bold(ownerEmail));
  console.log(
    kleur.dim("     That address is the owner, so it becomes an admin\n"),
  );

  console.log(kleur.bold("Available services:\n"));

  console.log("  Auth:   " + kleur.cyan("http://localhost:5312"));

  if (apiFramework) {
    console.log("  API:    " + kleur.cyan("http://localhost:3000"));
  }

  if (webFramework) {
    console.log("  Web:    " + kleur.cyan("http://localhost:5173"));
  }

  if (consoleUrl) {
    console.log("  Console:" + kleur.cyan(` ${consoleUrl}`));
  }

  console.log("");

  if (mobileFramework) {
    console.log(kleur.bold("Mobile app:\n"));
    console.log("  " + kleur.cyan("cd mobile && npm install && npx expo start"));
    console.log(
      kleur.dim(
        "  An Android emulator reaches the API at http://10.0.2.2:3000; set EXPO_PUBLIC_API_URL in mobile/.env.",
      ),
    );
    console.log(
      kleur.dim(
        "  Email codes and sign-in links work now. Passkeys need an associated domain; see mobile/README.md.\n",
      ),
    );
  }

  console.log(kleur.bold("Notes:\n"));

  console.log(kleur.dim("  • Web connects to API automatically"));
  console.log(kleur.dim("  • API connects to Auth automatically"));
  if (consoleUrl) {
    console.log(
      kleur.dim(
        adminMode === "api"
          ? "  • Admin console is served by the API at /console"
          : "  • Admin console uses the same auth system",
      ),
    );
  }
  if (adminMode === "source") {
    console.log(
      kleur.dim(
        "  • Admin console source is in admin/, yours to edit and commit",
      ),
    );
    console.log(
      kleur.dim("  • docker compose builds it from that directory, not an image"),
    );
  }
  console.log(
    kleur.dim(
      `  • ${ownerEmail} is the owner: registering with it grants the admin role`,
    ),
  );
  console.log(
    kleur.dim(
      "  • The grant happens at signup, so change OWNER_EMAIL in auth before registering",
    ),
  );
  console.log(kleur.dim("  • All secrets and keys are pre-configured\n"));

  console.log(
    kleur.dim("Docs: ") + kleur.cyan("https://docs.seamlessauth.com\n"),
  );

  console.log(kleur.bold().green("Setup complete.\n"));
}

export function printManagedSuccessOutput(config: {
  projectName?: string;
  webFramework: string | null;
  apiFramework: string | null;
  mobileFramework?: string | null;
  authServerUrl: string;
  appName: string;
  databaseUrl?: string;
}) {
  const {
    projectName,
    webFramework,
    apiFramework,
    mobileFramework = null,
    authServerUrl,
    appName,
    databaseUrl,
  } = config;

  const title = kleur.bold().cyan("SEAMLESS");

  console.log(`
╔════════════════════════════════════════╗
║          ${title}                      ║
╚════════════════════════════════════════╝
`);

  console.log(kleur.green("Project connected to a managed instance.\n"));

  console.log(kleur.dim("Managed application: ") + kleur.bold(appName));
  console.log(kleur.dim("Auth server:         ") + kleur.cyan(authServerUrl));
  console.log("");

  if (projectName) {
    console.log(kleur.dim("Project directory: ") + kleur.bold(projectName));
    console.log(kleur.cyan(`cd ${projectName}\n`));
  }

  console.log(kleur.bold("Included services:\n"));
  if (webFramework) {
    console.log(
      "  • " +
        kleur.white("Web application") +
        kleur.dim(` (${formatFramework(webFramework)})`),
    );
  }
  if (apiFramework) {
    console.log(
      "  • " +
        kleur.white("API server") +
        kleur.dim(` (${formatFramework(apiFramework)})`),
    );
  }
  if (mobileFramework) {
    console.log(
      "  • " +
        kleur.white("Mobile app") +
        kleur.dim(` (${formatFramework(mobileFramework)})`),
    );
  }
  console.log(
    "  • " + kleur.white("Auth server") + kleur.dim(" (managed instance)"),
  );
  console.log("");

  console.log(kleur.bold("Next steps:\n"));

  // The placeholders are the only thing standing between the scaffold and a
  // working database, so they lead rather than sitting in a footnote.
  if (databaseUrl) {
    console.log(kleur.dim("  # Database"));
    console.log(
      "  Fill in the credentials in " +
        kleur.cyan("api/.env") +
        kleur.dim(" (DATABASE_URL):"),
    );
    console.log("  " + kleur.dim(maskDatabaseUrl(databaseUrl)));
    console.log(
      kleur.dim("  Copy the user and password from the dashboard.\n"),
    );
  }

  if (apiFramework) {
    console.log(kleur.dim("  # API server"));
    console.log("  cd api && npm install && npm run dev\n");
  }
  if (webFramework) {
    console.log(kleur.dim("  # Web app"));
    console.log("  cd web && npm install && npm run dev\n");
  }
  if (mobileFramework) {
    console.log(kleur.dim("  # Mobile app"));
    console.log("  cd mobile && npm install && npx expo start\n");
    console.log(
      kleur.dim(
        "  Email codes and sign-in links work now. Passkeys need an associated domain; see mobile/README.md.\n",
      ),
    );
  }
  console.log("  Sign in from the web app to confirm the session resolves.\n");

  console.log(kleur.bold("Notes:\n"));
  console.log(
    kleur.dim(
      "  • The API service token was written to api/.env. Keep it out of version control.",
    ),
  );
  console.log(
    kleur.dim(
      "  • Auth, users, and OAuth providers are managed from the dashboard, not locally.",
    ),
  );
  console.log(
    kleur.dim("  • Rotate the service token anytime with the dashboard.\n"),
  );

  console.log(
    kleur.dim("Docs: ") + kleur.cyan("https://docs.seamlessauth.com\n"),
  );

  console.log(kleur.bold().green("Setup complete.\n"));
}

// Belt and braces: the CLI only ever holds a placeholder connection string, but
// anything printed as a connection string gets its userinfo masked so a real one
// pasted through here could never be echoed back in full.
export function maskDatabaseUrl(url: string): string {
  return url.replace(/\/\/[^@/]*@/, "//****:****@");
}

function formatFramework(name: string) {
  const map: Record<string, string> = {
    react: "React",
    express: "Express",
    angular: "Angular",
    next: "Next.js",
    fastapi: "FastAPI",
    fastify: "Fastify",
    vue: "Vue",
    expo: "Expo",
  };

  return map[name] || name;
}

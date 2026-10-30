import fs from "fs";
import os from "os";
import path from "path";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SEAMLESS_AUTH_ADMIN_DASHBOARD_COMMIT } from "../../core/images.js";
import { generateAdminSource } from "./admin.js";

let root: string;

// A stand-in for the GitHub archive: every entry nested under one top-level
// directory with the commit as the zip comment, the way `/archive/<ref>.zip` ships it.
function archive(
  files: Record<string, string>,
  top = "dashboard-1.0.0",
  commit = SEAMLESS_AUTH_ADMIN_DASHBOARD_COMMIT,
): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(`${top}/${name}`, Buffer.from(content));
  }
  zip.addZipComment(commit);
  return zip.toBuffer();
}

function servingArchive(buffer: Buffer, status = 200) {
  const fetchMock = vi.fn(async () =>
    status === 200
      ? new Response(new Uint8Array(buffer), { status })
      : new Response("nope", { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const DASHBOARD = {
  Dockerfile: "FROM node:22\n",
  "package.json": '{"name":"admin"}',
  "src/App.tsx": "export default () => null;\n",
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-admin-"));
  delete process.env.SEAMLESS_ADMIN_DASHBOARD_DIR;
  delete process.env.SEAMLESS_ADMIN_DASHBOARD_REF;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SEAMLESS_ADMIN_DASHBOARD_DIR;
  delete process.env.SEAMLESS_ADMIN_DASHBOARD_REF;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("generateAdminSource", () => {
  it("unpacks the dashboard into admin/, stripping the archive's top directory", async () => {
    servingArchive(archive(DASHBOARD));

    const dir = await generateAdminSource(root);

    expect(dir).toBe(path.join(root, "admin"));
    expect(fs.readFileSync(path.join(dir, "Dockerfile"), "utf-8")).toBe(
      "FROM node:22\n",
    );
    expect(fs.existsSync(path.join(dir, "src/App.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "dashboard-1.0.0"))).toBe(false);
  });

  it("requests the commit pinned for the tag the published image is built from", async () => {
    const fetchMock = servingArchive(archive(DASHBOARD));

    await generateAdminSource(root);

    expect(fetchMock).toHaveBeenCalledWith(
      `https://github.com/fells-code/seamless-auth-admin-dashboard/archive/${SEAMLESS_AUTH_ADMIN_DASHBOARD_COMMIT}.zip`,
    );
  });

  it("refuses an archive of a commit other than the pinned one, writing nothing", async () => {
    servingArchive(archive(DASHBOARD, undefined, "0".repeat(40)));

    await expect(generateAdminSource(root)).rejects.toThrow(
      new RegExp(`is commit 0{40}, but this CLI pins .* to ${SEAMLESS_AUTH_ADMIN_DASHBOARD_COMMIT}`),
    );
    expect(fs.existsSync(path.join(root, "admin"))).toBe(false);
  });

  it("refuses an archive that carries no commit", async () => {
    servingArchive(archive(DASHBOARD, undefined, ""));

    await expect(generateAdminSource(root)).rejects.toThrow(/is commit \(unknown\)/);
  });

  it("honours SEAMLESS_ADMIN_DASHBOARD_REF without checking it against the pin", async () => {
    const fetchMock = servingArchive(archive(DASHBOARD, undefined, "f".repeat(40)));
    process.env.SEAMLESS_ADMIN_DASHBOARD_REF = "main";

    await generateAdminSource(root);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/fells-code/seamless-auth-admin-dashboard/archive/main.zip",
    );
  });

  it("skips checkout artifacts the archive carries", async () => {
    servingArchive(
      archive({
        ...DASHBOARD,
        ".github/workflows/ci.yml": "on: push\n",
        "node_modules/left-pad/index.js": "module.exports = 1;",
      }),
    );

    const dir = await generateAdminSource(root);

    expect(fs.existsSync(path.join(dir, ".github"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "node_modules"))).toBe(false);
  });

  it("copies from a local checkout when SEAMLESS_ADMIN_DASHBOARD_DIR is set", async () => {
    const fetchMock = servingArchive(archive(DASHBOARD));
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-src-"));
    fs.writeFileSync(path.join(checkout, "Dockerfile"), "FROM local\n");
    fs.mkdirSync(path.join(checkout, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "node_modules", "x.js"), "");
    process.env.SEAMLESS_ADMIN_DASHBOARD_DIR = checkout;

    const dir = await generateAdminSource(root);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dir, "Dockerfile"), "utf-8")).toBe("FROM local\n");
    expect(fs.existsSync(path.join(dir, "node_modules"))).toBe(false);
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  it("reports a failed download with its status and URL", async () => {
    servingArchive(Buffer.from(""), 404);

    await expect(generateAdminSource(root)).rejects.toThrow(
      /Failed to download the admin dashboard \(404\)/,
    );
  });

  it("rejects an empty archive", async () => {
    servingArchive(new AdmZip().toBuffer());

    await expect(generateAdminSource(root)).rejects.toThrow(/archive was empty/);
  });

  // Entry names come from the archive. Not reachable while it is our own repository
  // over https, but this is what keeps a compromise of that source from becoming a
  // write anywhere the developer can write.
  it("refuses an entry that would write outside the project", async () => {
    const zip = new AdmZip();
    zip.addFile("dashboard-1.0.0/Dockerfile", Buffer.from("FROM node:22\n"));
    zip.addFile("dashboard-1.0.0/placeholder.txt", Buffer.from("pwned"));
    // addFile normalizes the name it is given, so the traversal is set afterwards.
    // A real archive can carry one: AdmZip returns `../` in entryName verbatim.
    zip.getEntries()[1].entryName = "dashboard-1.0.0/../../escaped.txt";
    zip.addZipComment(SEAMLESS_AUTH_ADMIN_DASHBOARD_COMMIT);
    servingArchive(zip.toBuffer());

    // A box around the project, so the entry's escape target is somewhere this test
    // owns and can clean up rather than the shared temp directory.
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-slip-"));
    const project = path.join(box, "project");
    fs.mkdirSync(project);

    await expect(generateAdminSource(project)).rejects.toThrow(
      /would write outside the project/,
    );
    expect(fs.existsSync(path.join(box, "escaped.txt"))).toBe(false);
    fs.rmSync(box, { recursive: true, force: true });
  });

  // `build: ./admin` in the generated compose file needs a Dockerfile there. Failing
  // during init names the problem; failing at `docker compose up` does not.
  it("fails when the unpacked dashboard has no Dockerfile", async () => {
    servingArchive(archive({ "package.json": "{}" }));

    await expect(generateAdminSource(root)).rejects.toThrow(
      /has no Dockerfile.*--admin=image/s,
    );
  });
});

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSeamlessConfig } from "./config.js";
import { VERSION } from "../../index.js";
import {
  SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE,
  SEAMLESS_AUTH_API_IMAGE,
} from "../../core/images.js";

let tmpDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-config-test-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  logSpy.mockRestore();
});

function readConfig(root: string) {
  return JSON.parse(
    fs.readFileSync(path.join(root, "seamless.config.json"), "utf-8"),
  );
}

describe("generateSeamlessConfig", () => {
  it("writes a managed config using the explicit managed details", () => {
    generateSeamlessConfig(tmpDir, {
      projectName: "my-app",
      webFramework: "react",
      apiFramework: "express",
      authMode: "managed",
      adminMode: "image",
      managed: {
        instanceUrl: "https://acme.seamlessauth.com",
        applicationId: "app-1",
        applicationName: "Acme",
      },
    });

    const config = readConfig(tmpDir);

    expect(config.version).toBe(VERSION);
    expect(config.projectName).toBe("my-app");
    expect(config.services.auth).toEqual({
      mode: "managed",
      instanceUrl: "https://acme.seamlessauth.com",
      applicationId: "app-1",
      applicationName: "Acme",
      image: null,
      path: null,
    });
    expect(config.services.admin).toEqual({
      mode: "hosted",
      image: null,
      path: null,
      url: null,
    });
    expect(config.services.database).toEqual({ type: "postgres" });
    expect(config.docker).toBeNull();
    expect(typeof config.createdAt).toBe("string");
    expect(new Date(config.createdAt).toString()).not.toBe("Invalid Date");
  });

  it("defaults managed fields to null when authMode is managed but no managed details are given", () => {
    generateSeamlessConfig(tmpDir, {
      webFramework: "react",
      apiFramework: "express",
      authMode: "managed",
      adminMode: "image",
    });

    const config = readConfig(tmpDir);

    expect(config.services.auth).toEqual({
      mode: "managed",
      instanceUrl: null,
      applicationId: null,
      applicationName: null,
      image: null,
      path: null,
    });
    // no projectName supplied, falls back to the root directory's basename
    expect(config.projectName).toBe(path.basename(tmpDir));
  });

  it("writes a docker-auth config with an image-mode admin dashboard", () => {
    generateSeamlessConfig(tmpDir, {
      projectName: "my-app",
      webFramework: "react",
      apiFramework: "express",
      authMode: "docker",
      adminMode: "image",
    });

    const config = readConfig(tmpDir);

    expect(config.services.auth).toEqual({
      mode: "docker",
      image: SEAMLESS_AUTH_API_IMAGE,
      path: null,
    });
    expect(config.services.admin).toEqual({
      mode: "image",
      image: SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE,
      path: null,
      url: null,
    });
    expect(config.docker).toEqual({ composeFile: "docker-compose.yml" });
  });

  it("records a mobile service only when a mobile starter was chosen", () => {
    generateSeamlessConfig(tmpDir, {
      projectName: "my-app",
      webFramework: "react",
      apiFramework: "express",
      mobileFramework: "expo",
      authMode: "docker",
      adminMode: "api",
    });
    expect(readConfig(tmpDir).services.mobile).toEqual({
      framework: "expo",
      path: "./mobile",
    });

    generateSeamlessConfig(tmpDir, {
      projectName: "my-app",
      webFramework: "react",
      apiFramework: "express",
      authMode: "docker",
      adminMode: "api",
    });
    expect(readConfig(tmpDir).services).not.toHaveProperty("mobile");
  });

  it("writes an api-served console config with the /console url", () => {
    generateSeamlessConfig(tmpDir, {
      projectName: "my-app",
      webFramework: "react",
      apiFramework: "express",
      authMode: "docker",
      adminMode: "api",
    });

    const config = readConfig(tmpDir);

    expect(config.services.admin).toEqual({
      mode: "api",
      image: null,
      path: null,
      url: "http://localhost:3000/console",
    });
  });

  it("writes a none-mode admin block when the console is omitted", () => {
    generateSeamlessConfig(tmpDir, {
      projectName: "my-app",
      webFramework: "react",
      apiFramework: "express",
      authMode: "docker",
      adminMode: "none",
    });

    const config = readConfig(tmpDir);

    expect(config.services.admin).toEqual({
      mode: "none",
      image: null,
      path: null,
      url: null,
    });
  });

  it("writes a local-auth config with a source-mode admin dashboard", () => {
    generateSeamlessConfig(tmpDir, {
      projectName: "my-app",
      webFramework: "vue",
      apiFramework: "fastify",
      authMode: "local",
      adminMode: "source",
    });

    const config = readConfig(tmpDir);

    expect(config.services.auth).toEqual({
      mode: "local",
      image: null,
      path: "./auth",
    });
    expect(config.services.admin).toEqual({
      mode: "source",
      image: null,
      path: "./admin",
      url: null,
    });
    expect(config.services.web).toEqual({ framework: "vue", path: "./web" });
    expect(config.services.api).toEqual({
      framework: "fastify",
      path: "./api",
    });
  });

  it("logs confirmation once the config file is created", () => {
    generateSeamlessConfig(tmpDir, {
      webFramework: "react",
      apiFramework: "express",
      authMode: "local",
      adminMode: "image",
    });

    expect(logSpy).toHaveBeenCalledWith("Seamless config created.");
  });
});

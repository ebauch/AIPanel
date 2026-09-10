// Generates the two example PDFs used by the "Resume vs. job description"
// example under public/examples/. Run with `npm run build:examples`.
//
// All content is entirely fictional (Jordan Lee, Northwind Analytics,
// Brightline Health, Meridian Labs) — not real people or companies.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "public", "examples");

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 56;
const BODY_SIZE = 10.5;
const HEADING_SIZE = 14;
const SUBHEADING_SIZE = 11.5;
const LINE_GAP = 14;

/**
 * A tiny text-layout engine: wraps plain-text blocks to the page width and
 * paginates automatically. Each block is either a heading, subheading,
 * paragraph, or bullet line.
 */
class PdfWriter {
  constructor(doc, fonts) {
    this.doc = doc;
    this.fonts = fonts;
    this.page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  ensureSpace(needed) {
    if (this.y - needed < MARGIN) {
      this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      this.y = PAGE_HEIGHT - MARGIN;
    }
  }

  wrapLines(text, font, size, maxWidth) {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let current = "";

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) {
      lines.push(current);
    }
    return lines;
  }

  heading(text) {
    this.ensureSpace(HEADING_SIZE + 10);
    this.page.drawText(text, {
      x: MARGIN,
      y: this.y,
      size: HEADING_SIZE,
      font: this.fonts.bold,
      color: rgb(0.1, 0.1, 0.15),
    });
    this.y -= HEADING_SIZE + 8;
  }

  subheading(text) {
    this.ensureSpace(SUBHEADING_SIZE + 8);
    this.page.drawText(text, {
      x: MARGIN,
      y: this.y,
      size: SUBHEADING_SIZE,
      font: this.fonts.bold,
      color: rgb(0.15, 0.15, 0.2),
    });
    this.y -= SUBHEADING_SIZE + 6;
  }

  paragraph(text) {
    const maxWidth = PAGE_WIDTH - MARGIN * 2;
    const lines = this.wrapLines(text, this.fonts.regular, BODY_SIZE, maxWidth);
    for (const line of lines) {
      this.ensureSpace(LINE_GAP);
      this.page.drawText(line, {
        x: MARGIN,
        y: this.y,
        size: BODY_SIZE,
        font: this.fonts.regular,
        color: rgb(0.15, 0.15, 0.18),
      });
      this.y -= LINE_GAP;
    }
    this.y -= 4;
  }

  bullet(text) {
    const bulletIndent = 14;
    const maxWidth = PAGE_WIDTH - MARGIN * 2 - bulletIndent;
    const lines = this.wrapLines(text, this.fonts.regular, BODY_SIZE, maxWidth);
    lines.forEach((line, index) => {
      this.ensureSpace(LINE_GAP);
      const prefix = index === 0 ? "•  " : "   ";
      this.page.drawText(`${prefix}${line}`, {
        x: MARGIN,
        y: this.y,
        size: BODY_SIZE,
        font: this.fonts.regular,
        color: rgb(0.15, 0.15, 0.18),
      });
      this.y -= LINE_GAP;
    });
  }

  spacer(amount = 6) {
    this.y -= amount;
  }
}

async function buildResumePdf() {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new PdfWriter(doc, { regular, bold });

  w.heading("Jordan Lee");
  w.paragraph(
    "Product Manager · jordan.lee@example.com · (555) 019-2231 · Remote / San Francisco Bay Area",
  );
  w.spacer(4);

  w.subheading("Summary");
  w.paragraph(
    "Product manager with six years of experience shipping data and analytics products for B2B SaaS companies. Skilled at translating ambiguous customer problems into shippable roadmaps, partnering closely with engineering and design, and using quantitative analysis to prioritize ruthlessly. Led two products from zero to their first meaningful revenue milestones.",
  );

  w.subheading("Experience");

  w.paragraph("Senior Product Manager — Brightline Health (2023–Present)");
  w.bullet(
    "Owned the clinician-facing analytics dashboard used by 1,200+ care teams; redesigned the metrics pipeline, cutting report-generation time from 40 minutes to under 90 seconds.",
  );
  w.bullet(
    "Ran quarterly discovery interviews with 30+ hospital administrators to identify the top three retention risks, resulting in a roadmap that reduced churn by 18% year over year.",
  );
  w.bullet(
    "Partnered with data science to launch a predictive readmission-risk feature, now used in 60% of active accounts within two quarters of release.",
  );
  w.bullet(
    "Managed a cross-functional team of 8 engineers and 2 designers using a lightweight Kanban process; shipped on a two-week release cadence with no missed deadlines in 12 months.",
  );

  w.paragraph("Product Manager — Northwind Analytics (2020–2023)");
  w.bullet(
    "Launched the company's first self-serve reporting tool, growing self-serve adoption from 0 to 35% of the customer base within a year.",
  );
  w.bullet(
    "Defined and tracked activation metrics for the onboarding funnel, improving 30-day activation from 42% to 61% through three iterative experiments.",
  );
  w.bullet(
    "Wrote and maintained the product requirements process adopted company-wide, reducing average scoping time for new initiatives by roughly a third.",
  );

  w.paragraph("Associate Product Manager — Northwind Analytics (2019–2020)");
  w.bullet(
    "Supported the founding PM on the core reporting product; owned bug triage and small feature iterations, shipping 40+ incremental improvements.",
  );
  w.bullet(
    "Built the team's first customer feedback taxonomy, used to prioritize the following two product roadmaps.",
  );

  w.subheading("Skills");
  w.paragraph(
    "Roadmapping and prioritization, SQL and data analysis, A/B testing and experimentation, user research, cross-functional leadership, stakeholder communication, Figma (collaborative reviews), Amplitude, Looker.",
  );

  w.subheading("Education");
  w.paragraph(
    "B.S. in Economics, University of California, Davis — Graduated 2019. Coursework in statistics and applied data analysis.",
  );

  return doc.save();
}

async function buildJobDescriptionPdf() {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new PdfWriter(doc, { regular, bold });

  w.heading("Senior Product Manager, Data Platform");
  w.paragraph("Meridian Labs · Full-time · Remote (US) or Austin, TX");
  w.spacer(4);

  w.subheading("About the role");
  w.paragraph(
    "Meridian Labs builds infrastructure that helps mid-market companies unify and analyze their operational data. We're hiring a Senior Product Manager to own our Data Platform product line — the pipelines, transformation tools, and internal APIs that power every customer-facing analytics feature we ship. You'll set the roadmap for a platform used by every other product team in the company, working closely with engineering leadership, data science, and enterprise customers.",
  );

  w.subheading("Responsibilities");
  w.bullet(
    "Own the strategy and roadmap for the Data Platform, balancing near-term reliability and performance work against longer-term platform investments.",
  );
  w.bullet(
    "Partner with engineering to define system-level requirements for data ingestion, transformation, and storage that other product teams build on top of.",
  );
  w.bullet(
    "Work directly with large enterprise customers to understand data volume, latency, and compliance requirements, translating them into prioritized platform work.",
  );
  w.bullet(
    "Define and track platform health metrics (pipeline reliability, data freshness, API latency) and drive quarterly improvement targets.",
  );
  w.bullet(
    "Act as the internal voice of the platform for other product teams, running a lightweight intake process for new platform requests.",
  );
  w.bullet(
    "Present roadmap and quarterly results to executive leadership and, periodically, to key enterprise accounts.",
  );

  w.subheading("Requirements");
  w.bullet("5+ years of product management experience, including platform, infrastructure, or data-heavy products.");
  w.bullet(
    "Comfortable reading SQL and working directly with engineers on system design tradeoffs, without needing to write production code.",
  );
  w.bullet(
    "Track record of shipping products that other internal teams or external developers build on top of (platform or API experience strongly preferred).",
  );
  w.bullet(
    "Strong written communication; able to turn ambiguous technical tradeoffs into a clear roadmap for both engineers and executives.",
  );
  w.bullet("Experience working with enterprise customers with formal data governance or compliance requirements.");

  w.subheading("Nice to have");
  w.bullet("Experience in healthcare, fintech, or another regulated industry.");
  w.bullet("Prior experience as a data analyst or data engineer before moving into product management.");
  w.bullet("Familiarity with modern data-stack tools (dbt, Airflow, Snowflake, or similar).");

  w.subheading("What we offer");
  w.paragraph(
    "Competitive salary and equity, fully remote-friendly with an optional Austin office, comprehensive health coverage, and a professional development budget. Meridian Labs is an equal opportunity employer.",
  );

  return doc.save();
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const [resumeBytes, jobDescriptionBytes] = await Promise.all([
    buildResumePdf(),
    buildJobDescriptionPdf(),
  ]);

  await writeFile(path.join(outDir, "resume-jordan-lee.pdf"), resumeBytes);
  await writeFile(
    path.join(outDir, "job-description-senior-product-manager.pdf"),
    jobDescriptionBytes,
  );

  console.log("Wrote public/examples/resume-jordan-lee.pdf");
  console.log("Wrote public/examples/job-description-senior-product-manager.pdf");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

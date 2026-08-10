const ORG_NAME = "Secant Labs";
const GITHUB_URL = "https://github.com/secantlabs/secantlabsmonorepo";

type Status = "live" | "building" | "planned";

interface Tool {
  name: string;
  subject: string;
  status: Status;
  description: string;
  href?: string;
}

const TOOLS: Tool[] = [
  {
    name: "Warp",
    subject: "Linear algebra",
    status: "live",
    href: "https://warp.us.com",
    description:
      "Type a matrix and watch it warp space — basis vectors, determinants as areas and volumes, eigenvectors riding the transformation, compositions animating factor by factor. In 2D and 3D.",
  },
  {
    name: "Warp Lessons",
    subject: "Guided walkthroughs",
    status: "building",
    // Stays on the toringastich account on purpose: this is the frozen Summer
    // of Math Exposition entry URL, and only that repo's Pages site can serve
    // it. Repoint after judging closes (Aug 30).
    href: "https://toringastich.github.io/warp-lessons/",
    description:
      "Click-through, fully interactive lessons built on Warp — starting with eigenvectors. Read a little, watch the space move, then try it yourself in the sandbox. Summer of Math Exposition 2026 entry.",
  },
  {
    name: "Flux",
    subject: "Vector calculus",
    status: "live",
    // A subpath of this same Pages site, not its own domain — which is why Flux
    // can ship without disturbing the one custom domain this repo publishes.
    href: "/flux/",
    description:
      "Type two components and the plane fills with arrows — including the inverse-square, rotational and singular fields that defeat a naive plotter, with singularities marked rather than smeared. Drag a point through the field, trace a parameterized curve, and watch divergence and curl update as you type.",
  },
  {
    name: "Complex analysis",
    subject: "Future tool",
    status: "planned",
    description:
      "See holomorphic functions warp the complex plane: conformal maps that keep angles honest, Möbius transformations, domain coloring, and the derivative as a local rotate-and-stretch.",
  },
];

const STATUS_LABEL: Record<Status, string> = {
  live: "Live",
  building: "In progress",
  planned: "Planned",
};

const PRINCIPLES = [
  {
    title: "Free, and staying that way",
    body: "Every tool is free to use — no account, no paywall, no lesson you have to unlock. Students are who these are for.",
  },
  {
    title: "Nothing to install",
    body: "Everything runs client-side in the browser. No backend holds your work, and a scene is just a URL, so sharing one is sending a link.",
  },
  {
    title: "Built for intuition, not answers",
    body: "These aren't solvers. They show you the object acting on space, so the theorem arrives as something you watched happen rather than something you took on faith.",
  },
];

/** A sheared grid — the brand motif: straight lines, warped space. */
function HeroGrid() {
  const lines = [];
  for (let i = -10; i <= 26; i++) {
    lines.push(
      <line key={`v${i}`} x1={i * 60} y1={-40} x2={i * 60} y2={400} />,
    );
  }
  for (let j = 0; j <= 8; j++) {
    lines.push(
      <line key={`h${j}`} x1={-600} y1={j * 60} x2={2200} y2={j * 60} />,
    );
  }
  return (
    <svg className="hero-grid" aria-hidden="true">
      <g transform="skewX(-18)">{lines}</g>
    </svg>
  );
}

function ToolCard({ tool }: { tool: Tool }) {
  const inner = (
    <>
      <div className="card-top">
        <span className="card-subject">{tool.subject}</span>
        <span className={`card-status ${tool.status}`}>
          {STATUS_LABEL[tool.status]}
        </span>
      </div>
      <h3 className="card-name">{tool.name}</h3>
      <p className="card-desc">{tool.description}</p>
      {tool.href && <span className="card-cta">Open →</span>}
    </>
  );
  return tool.href ? (
    <a className="card card-link" href={tool.href}>
      {inner}
    </a>
  ) : (
    <div className="card">{inner}</div>
  );
}

export default function App() {
  return (
    <div className="page">
      <nav className="nav">
        <a className="brand" href="/">
          <img className="brand-mark" src="/logo.svg" alt="" width="24" height="24" />
          <span className="brand-name">{ORG_NAME}</span>
        </a>
        <div className="nav-links">
          <a href="#tools">Tools</a>
          <a href="#about">About</a>
          <a href={GITHUB_URL}>GitHub</a>
        </div>
      </nav>

      <header className="hero">
        <HeroGrid />
        <div className="hero-inner">
          <p className="hero-eyebrow">{ORG_NAME}</p>
          <h1>See what the math does.</h1>
          <p className="hero-sub">
            We make Warp and other interactive tools for seeing the mathematics
            where intuition goes missing. Type a mathematical object — a matrix,
            a function, a field — and watch it act on space. Free, in your
            browser, nothing to set up.
          </p>
          <div className="hero-actions">
            <a className="btn btn-primary" href="https://warp.us.com">
              Open Warp
            </a>
            <a className="btn btn-ghost" href="#tools">
              See all tools
            </a>
          </div>
        </div>
      </header>

      <main>
        <section className="section" id="tools">
          <div className="section-head">
            <h2>Our tools</h2>
            <p>
              One sandbox per course, all built on the same engine. Two are live
              today; the rest are on the way.
            </p>
          </div>
          <div className="cards">
            {TOOLS.map((t) => (
              <ToolCard key={t.name} tool={t} />
            ))}
          </div>
        </section>

        <section className="section section-about" id="about">
          <div className="section-head">
            <h2>Why we build these</h2>
            <p>
              A lot of mathematics is hard only because it is invisible. A
              matrix is a table of numbers until you watch it move the plane —
              and then it is obvious, and it stays obvious. {ORG_NAME} exists to
              build that moment for the courses that need it most, and to give
              it away.
            </p>
            <p>
              A secant line is the rough guess that becomes the tangent in the
              limit: start with something you can actually see, then refine.
              That's the name, and it's the method.
            </p>
          </div>
          <ul className="principles">
            {PRINCIPLES.map((p) => (
              <li key={p.title}>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="footer">
        <span>
          {ORG_NAME} · built by Torin Gastich · inspired by the belief that
          mathematics must be visualized
        </span>
        <a href={GITHUB_URL}>GitHub</a>
      </footer>
    </div>
  );
}

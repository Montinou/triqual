"use client"

import { useState } from "react"
import { ScrollSection } from "@/components/shared/scroll-section"
import { DiagramViewer, DiagramHotspot } from "@/components/diagrams/diagram-viewer"
import { ExpandablePanel, DocLink } from "@/components/diagrams/expandable-panel"

// Diagram expansion content
const expansions = {
  context: {
    title: "Context Loading Subprocess",
    diagram: "/flow-images/07-context_loading.png",
    content: (
      <div className="space-y-4">
        <p>
          Before generating any test code, Triqual spawns a headless Claude subprocess (Sonnet) that builds comprehensive context by:
        </p>
        <ul className="space-y-2 list-disc list-inside">
          <li>Searching Quoth for proven patterns and anti-patterns</li>
          <li>Querying Exolar for failure history and similar tests</li>
          <li>Scanning codebase for relevant source files and selectors</li>
          <li>Identifying reusable Page Objects, helpers, and fixtures</li>
        </ul>
        <p>
          Context files are written to <code>.triqual/context/{"{feature}"}/</code> and consumed by all agents.
        </p>
      </div>
    ),
    links: [
      { label: "Quoth Integration", href: "/docs/quoth-integration" },
      { label: "Exolar Integration", href: "/docs/exolar-integration" },
    ],
  },
  loop: {
    title: "RUN → FIX Loop with Hook Enforcement",
    diagram: "/flow-images/05-hook_enforcement.png",
    content: (
      <div className="space-y-4">
        <p>
          The test-healer agent runs tests autonomously and applies fixes in a loop until tests pass or 25 attempts reached:
        </p>
        <ul className="space-y-2 list-disc list-inside">
          <li><strong>Attempt 1-3:</strong> Standard healing with pattern application</li>
          <li><strong>Attempt 12+:</strong> Deep analysis phase with expanded Quoth/Exolar research</li>
          <li><strong>Attempt 25:</strong> Mark .fixme() or provide justification</li>
        </ul>
        <p>
          Hooks enforce documentation at every stage and block actions that violate quality gates.
        </p>
      </div>
    ),
    links: [
      { label: "Getting Started", href: "/docs/bootstrap-workflow" },
      { label: "Standard Patterns", href: "/docs/standard-patterns" },
    ],
  },
  learn: {
    title: "Learning Loop & Pattern Extraction",
    diagram: "/flow-images/06-learning_loop.png",
    content: (
      <div className="space-y-4">
        <p>
          After test success, Triqual extracts patterns from the documented journey and captures them for future use:
        </p>
        <ul className="space-y-2 list-disc list-inside">
          <li>Analyze all RUN and FIX stages from run log</li>
          <li>Identify recurring patterns and solutions</li>
          <li>Update project knowledge.md with learnings</li>
          <li>Propose patterns to Quoth for team-wide sharing</li>
        </ul>
        <p>
          Every test that passes makes future tests smarter and faster.
        </p>
      </div>
    ),
    links: [
      { label: "Quoth Integration", href: "/docs/quoth-integration" },
      { label: "Locator Strategies", href: "/docs/locator-strategies" },
    ],
  },
}

export function WorkflowDiagramJourney() {
  const [expandedPanel, setExpandedPanel] = useState<keyof typeof expansions | null>(null)

  const hotspots: DiagramHotspot[] = [
    {
      x: 50,
      y: 15,
      label: "LOAD CONTEXT",
      description: "Click to see context loading subprocess",
      color: "purple",
      onExpand: () => setExpandedPanel("context"),
    },
    {
      x: 50,
      y: 55,
      label: "RUN → FIX",
      description: "Click to see healing loop",
      color: "cyan",
      onExpand: () => setExpandedPanel("loop"),
    },
    {
      x: 50,
      y: 85,
      label: "LEARN",
      description: "Click to see pattern extraction",
      color: "green",
      onExpand: () => setExpandedPanel("learn"),
    },
  ]

  return (
    <ScrollSection
      id="workflow"
      title="How Triqual Works: The Full Journey"
      subtitle="Explore each stage of the autonomous test generation flow"
      className="bg-background"
    >
      <div className="flex flex-col items-center">
        <DiagramViewer
          src="/flow-images/02-test_generation_flow.png"
          alt="Test Generation Flow - Complete Workflow"
          hotspots={hotspots}
          size="full"
          animateEntry={true}
          use3D={true}
          priority={false}
        />

        <p className="mt-8 text-center text-foreground-secondary text-sm">
          Click the <span className="text-primary">+</span> markers to explore each stage in detail →
        </p>
      </div>

      {/* Expandable panels */}
      {(Object.keys(expansions) as Array<keyof typeof expansions>).map((key) => (
        <ExpandablePanel
          key={key}
          isOpen={expandedPanel === key}
          onClose={() => setExpandedPanel(null)}
          title={expansions[key].title}
          diagram={expansions[key].diagram}
          content={expansions[key].content}
          relatedLinks={expansions[key].links}
        />
      ))}
    </ScrollSection>
  )
}

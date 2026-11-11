declare module '*/generated/docs-graph.json' {
  const graphData: {
    nodeCount: number;
    packages: { id: string; label: string; routes: string[] }[];
    nodes: {
      id: string;
      package: string;
      packageLabel: string;
      category: string;
      categoryLabel: string;
      title: string;
      route: string;
      breadcrumb: string[];
      summary: string;
      body: string;
      related: string[];
    }[];
  };
  export default graphData;
}

declare module '*/generated/chunk-index.json' {
  const chunkIndex: {
    dim: number;
    model: string;
    chunks: {
      id: string;
      route: string;
      docTitle: string;
      heading: string;
      text: string;
      vector: number[];
    }[];
  };
  export default chunkIndex;
}

type PaletteColorId =
  | "blue"
  | "purple"
  | "green"
  | "pink"
  | "amber"
  | "teal"
  | "terracotta"
  | "gray";

type PaletteColorOption = {
  color: string;
  id: PaletteColorId;
};

export const paletteColorOptions: PaletteColorOption[] = [
  { color: "#608ef8", id: "blue" },
  { color: "#8d6bd8", id: "purple" },
  { color: "#5da982", id: "green" },
  { color: "#dc6595", id: "pink" },
  { color: "#d28b36", id: "amber" },
  { color: "#37a3a5", id: "teal" },
  { color: "#c0674f", id: "terracotta" },
  { color: "#7f8a99", id: "gray" },
];

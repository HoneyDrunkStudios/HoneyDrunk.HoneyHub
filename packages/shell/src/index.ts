export interface ShellDescriptor {
  name: string;
  bundlesBridge: boolean;
  toolkit: "tauri-class";
}

export const shellDescriptor: ShellDescriptor = {
  name: "HoneyHub Desktop Shell",
  bundlesBridge: true,
  toolkit: "tauri-class"
};

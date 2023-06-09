import { TextArea } from "./TextArea";
import { useState } from "react";

interface TestTextAreaProps {}

export const TestTextArea = ({}: TestTextAreaProps): JSX.Element => {
  const [value, setValue] = useState("");

  return (
    <main className="px-4 py-2 bg-black rounded-lg">
      <TextArea
        className="max-h-[80svh]"
        value={value}
        onChange={(newValue) => setValue(newValue)}
      />
    </main>
  );
};

export default TestTextArea;

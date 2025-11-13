import React, { useState } from "react";
import axios from "axios";
import {toast} from "react-toastify";

function App() {
  const [file, setFile] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState(null);

  const base_url = import.meta.env.VITE_BACKEND_BASE_URL;;

  const handleFile = (f) => {
    setFile(f);
    setData(null);
    setError(null);
  };

  const handleChange = (e) => {
    if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
  };

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    if (e.type === "dragleave") setDragActive(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  };

  const handleUpload = async (e) => {
    e?.preventDefault();
    if (!file) return;
    setLoading(true);
    setError(null);
    const formData = new FormData();
    formData.append("pdf", file);

    try {
        const response = await axios.post(`${base_url}/api/pdf-to-csv`, formData);
      console.log("Response data:", response.data);
      setData(response.data);
      toast.success("PDF converted successfully!");
    } catch (error) {
      console.error("Error:", error);
      setError(error.response?.data?.error || "Upload failed. See console for details.");
      toast.error("Failed to convert PDF.");
      toast.error(error.response?.data?.error || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const downloadCSV = () => {
    if (!data?.csv) return;
    const element = document.createElement("a");
    element.href = "data:text/csv;charset=utf-8," + encodeURIComponent(data.csv);
    element.download = `billing_data_${Date.now()}.csv`;
    element.click();
    toast.success("CSV downloaded successfully!");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl bg-white rounded-lg shadow-xl p-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">PDF to CSV Converter</h1>
        <p className="text-gray-600 mb-8">Convert your billing PDFs to CSV format</p>
        
        <form onSubmit={handleUpload} className="space-y-6">
          <div
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-lg p-8 text-center transition ${
              dragActive ? "border-blue-500 bg-blue-50" : "border-gray-300 bg-gray-50"
            }`}
          >
            <input
              type="file"
              id="file-input"
              accept=".pdf"
              onChange={handleChange}
              className="hidden"
            />
            <label htmlFor="file-input" className="cursor-pointer">
              <div className="text-4xl mb-2">📄</div>
              <p className="text-gray-700 font-medium">
                {file ? file.name : "Drag and drop your PDF here"}
              </p>
              <p className="text-gray-500 text-sm mt-1">or click to browse</p>
            </label>
          </div>

          <button
            type="submit"
            disabled={!file || loading}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-semibold py-3 rounded-lg transition"
          >
            {loading ? "Converting..." : "Convert PDF"}
          </button>
        </form>

        {error && (
          <div className="mt-4 p-4 bg-red-100 text-red-700 rounded-lg">
            {error}
          </div>
        )}

        {data?.csv && (
          <div className="mt-8 space-y-4">
            <div className="p-4 bg-green-100 text-green-700 rounded-lg">
              ✅ Successfully extracted {data.recordCount} records
            </div>

            <button
              onClick={downloadCSV}
              className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-lg transition"
            >
              ⬇️ Download CSV
            </button>

            <div className="mt-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">Preview (First 5 rows)</h2>
              <div className="overflow-x-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-gray-200">
                    <tr>
                      {Object.keys(data.data[0] || {}).map((header) => (
                        <th key={header} className="px-4 py-2 text-left font-semibold">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.data.slice(0, 5).map((row, i) => (
                      <tr key={i} className={i % 2 === 0 ? "bg-gray-50" : ""}>
                        {Object.values(row).map((val, j) => (
                          <td key={j} className="px-4 py-2 text-gray-700">
                            {val}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
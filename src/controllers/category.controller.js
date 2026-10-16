const Category=require("../models/Category");

//Create

async function createCatergory (req,res){
try{
    const category= await Category.create(req.body);
    res.status(201).json(category);
}
catch(error){
    res.status(500).json({messag : error.message});
}
};

//Get ALL

async function getCategories (req,res){
    const categories = await Category.find();
    res.json(categories);
};

// ✅ UPDATE
async function updateCategory(req, res) {
  try {
    const category = await Category.findByIdAndUpdate(
      req.params.id,
      req.body,
      { returnDocument: "after" } // trả về dữ liệu sau khi update
    );

    if (!category) {
      return res.status(404).json({ message: "Category không tồn tại" });
    }

    res.json(category);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// ✅ DELETE
async function deleteCategory(req, res) {
  try {
    const category = await Category.findByIdAndDelete(req.params.id);

    if (!category) {
      return res.status(404).json({ message: "Category không tồn tại" });
    }

    res.json({ message: "Xóa category thành công" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

module.exports={createCatergory,getCategories,updateCategory,deleteCategory};